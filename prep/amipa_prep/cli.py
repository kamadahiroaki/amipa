#!/usr/bin/env python3
"""amipa prep — GFA を渡すだけで AMIPA アトラス（多層 SQLite DB ＋ サイドカー）を作る。

    # 一気通貫（⓪distill → ①povu → ②LOD → ③layout → ④emit → bundle）
    amipa prep run --gfa graph.gfa --out mygraph.amipa --threads 16

    # アノテやリードも一緒に（同じ 1 コマンドで最後まで）
    amipa prep run --gfa graph.gfa --out mygraph.amipa \
        --band cytoBand.hg38.txt.gz --gene gencode.v50.gtf.gz \
        --region chm13.regions.bed --region-ref chm13 \
        --reads HG002=HG002.gaf

    # 後から足す（DB は作り直さない）
    amipa prep add-annot --out mygraph.amipa --gene gencode.v50.gtf.gz
    amipa prep add-reads --out mygraph.amipa --reads HG002=HG002.gaf

    # 途中から/一段だけやり直す
    amipa prep status --out mygraph.amipa
    amipa prep run --out mygraph.amipa --from layout      # layout 以降を作り直す
    amipa prep run --out mygraph.amipa --only emit        # emit だけ
    # ジョブスケジューラで回すとき: 資源の目安を見てから、自分の環境の書式で
    # ジョブスクリプトを書き、その中で上の run（必要なら --only <段>）を呼ぶ。
    amipa prep plan --gfa graph.gfa --out mygraph.amipa  # 段ごとのスロット/メモリ/時間の目安
    #                                                      雛形は examples/hpc/

**再開の考え方**: 段ごとに「コマンド行＋入力ファイルの署名(サイズ,mtime)」から鍵を作って
`state.json` に記録する。次回は鍵と出力の実在を照合し、変わっていない段は飛ばす。
後段の鍵は**その段の入力ファイルの署名**を含むので、前段が実際に出力を書き換えたときだけ
後段も自動的に走り直す（無関係な段は走らない）。
★鍵に「環境で変わるだけで出力を変えない値」（メモリ予算・一時ディレクトリ名など）を
入れないこと。入れると「何も変えていないのに毎回やり直し」になる。

**環境依存の扱い**（詳細は docs/PIPELINE_PORTABILITY.md）:
  --tmp        ④のDBビルドとリボン spill の置き場。既定は
               **$TMPDIR → /tmp → <out>/work/tmp** のうち空きが足りる最初のもの。
               共有FS(Lustre 等)を選ぶと警告する（動くが SQLite のランダム書込が桁で遅くなる）。
  --threads    段ごとに並列性が違う（②は決定性のため常に 1 スレッド固定）。
  --mem-gib    ③の pivot 配列のメモリ予算。既定は MemAvailable の 60%。
  --template   ④が**スキーマ供給用に既存 DB を必要とする**ため。既定は同梱の空テンプレ。
"""
from __future__ import annotations   # 型注釈を遅延評価（Python 3.9 で `str | None` を書けるように）

import argparse
import glob
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

PKG = Path(__file__).resolve().parent                  # …/prep/amipa_prep
DEFAULT_TEMPLATE = PKG / "templates" / "schema.db"
# povu は PATH 上（コンテナは /usr/local/bin/povu）。AMIPA_POVU で明示指定できる。
DEFAULT_POVU = Path(os.environ.get("AMIPA_POVU") or os.environ.get("GGB_POVU") or "povu")

# 実行順。annot / reads は入力が指定された時だけ走る。
STAGES = ["distill", "decompose", "lod", "layout", "emit", "annot", "reads", "bundle"]

STATE_VERSION = 1


# ───────────────────────────── 小道具 ─────────────────────────────

def log(msg: str) -> None:
    print(f"[amipa {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def die(msg: str, code: int = 1):
    print(f"[amipa] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def sig(p: Path) -> str:
    """入力の署名。ファイル=サイズ:mtime、ディレクトリ=件数:総サイズ:最終mtime。

    ★`*.layered.db` だけは mtime でなく **emitter が刻んだ素性**(built_at + emitter_rev)を使う。
      DB は後段（reads の索引付与や viewer のノード編集）で**中身が追記されて mtime が動く**が、
      annot から見た「どのグラフのどの emit か」は変わらない。mtime を見ると
      「リードを足しただけでアノテを作り直す」ような無駄な再実行が起きる。
    """
    try:
        if str(p).endswith(".layered.db") and p.is_file():
            import sqlite3
            try:
                con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
                m = dict(con.execute(
                    "SELECT key,value FROM db_meta WHERE key IN ('built_at','emitter_rev')"))
                con.close()
                if m:
                    return f"db{m.get('built_at')}:{m.get('emitter_rev')}:{p.stat().st_size}"
            except Exception:
                pass                      # 読めないときは通常のファイル署名に落ちる
        if p.is_dir():
            n = tot = mt = 0
            for root, _, files in os.walk(p):
                for f in files:
                    st = os.stat(os.path.join(root, f))
                    n += 1
                    tot += st.st_size
                    mt = max(mt, st.st_mtime_ns)
            return f"d{n}:{tot}:{mt}"
        st = p.stat()
        return f"f{st.st_size}:{st.st_mtime_ns}"
    except FileNotFoundError:
        return "missing"


def human(n: float) -> str:
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return f"{n:.1f}{u}"
        n /= 1024
    return ""


def mem_available_gib() -> float:
    """使ってよいメモリの目安(GiB)。

    ★ノードの MemAvailable だけを見てはいけない。AGE の `-l s_vmem` は**仮想メモリの上限**
    (RLIMIT_AS)として効くので、計算ノードに 700GB 空きがあってもジョブは s_vmem で殺される。
    両者の小さい方を採る。
    """
    node = 8.0
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                node = int(line.split()[1]) / (1024 * 1024)
                break
    except Exception:
        pass
    try:
        import resource
        soft, _ = resource.getrlimit(resource.RLIMIT_AS)
        if soft not in (resource.RLIM_INFINITY, -1):
            node = min(node, soft / (1024 ** 3))
    except Exception:
        pass
    # ★コンテナの上限。/proc/meminfo は**ホストの**値を返すので、docker/podman の
    #   `--memory` や k8s の limit を見ないと過大評価して OOM kill される。
    for f in ("/sys/fs/cgroup/memory.max",                       # cgroup v2
              "/sys/fs/cgroup/memory/memory.limit_in_bytes"):    # cgroup v1
        try:
            v = Path(f).read_text().strip()
            if v not in ("max", ""):
                lim = int(v) / (1024 ** 3)
                if 0 < lim < 1024 * 1024:      # v1 は「無制限」を巨大な数で表すので弾く
                    node = min(node, lim)
            break
        except Exception:
            continue
    return node


def clamp(v: float, lo: float, hi: float) -> int:
    return int(max(lo, min(hi, v)))


def fs_type(p: Path) -> str:
    try:
        return subprocess.run(["stat", "-f", "-c", "%T", str(p)],
                              capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        return "?"


NETWORK_FS = ("lustre", "nfs", "gpfs", "cifs", "fuseblk", "beegfs", "smb2")


def resolve_tmp(explicit, out_dir: Path, gfa: Path | None,
                purpose: str = "build", need_factor: float = 6.0) -> Path:
    """一時領域を決める。**用途ごとに別々に呼ぶ**（purpose="build" / "spill"）。

    ★明示（--tmp / --spill）されていれば**それをそのまま使う**（候補探索はしない）。
      本番のジョブスクリプトからは常に明示するのが前提で、以下の探索は
      「手元で気軽に試すとき」のための保険。
    探索順: $TMPDIR（スケジューラがジョブ専用に用意することが多い） → /tmp
            → <out>/work/tmp（出力と同じ場所。速くはないが容量はある）
    空きが目安(GFA×need_factor)に足りない候補は飛ばし、最後の候補は足りなくても使って警告する。
    共有FS を選んだ場合も警告する（用途によっては正しい選択なので止めはしない）。

    用途による違い:
      build … ④の DB を組む場所。**ランダム書込**なのでローカルが要る。必要量 ≒ 最終 DB
      spill … リボン/多重度の disk streaming。**順次書き**なので共有FSでも実害が小さく、
              必要量が桁違いに大きいことがある（MC v2 実測で最大 2.3TB）
    """
    need = max(2 * 1024 ** 3, int((gfa.stat().st_size if gfa else 0) * need_factor))
    cands = []
    if explicit:
        cands.append(("明示指定", Path(explicit)))
    else:
        if os.environ.get("TMPDIR"):
            cands.append(("$TMPDIR", Path(os.environ["TMPDIR"])))
        cands.append(("/tmp", Path("/tmp")))
        cands.append(("<out>/work/tmp", out_dir / "work" / "tmp"))

    for label, d in cands:
        try:
            d.mkdir(parents=True, exist_ok=True)
            free = shutil.disk_usage(d).free
        except Exception as e:
            log(f"一時領域の候補 {label}={d} が使えない ({e})")
            continue
        if free < need and label != "明示指定" and len(cands) > 1 and d != cands[-1][1]:
            log(f"{purpose}用 {label}={d} は空き {human(free)} < 目安 {human(need)} → 次の候補へ")
            continue
        ft = fs_type(d)
        if ft in NETWORK_FS and purpose == "build":
            log(f"⚠ build 用 {d} は共有FS({ft})。④の SQLite ランダム書込がネットワーク律速になる。")
            log("  ノードローカルの速いディスクを --tmp で指すと桁で速くなる。")
        if free < need:
            log(f"⚠ {purpose}用 {d} の空きが {human(free)}（目安 {human(need)}）。途中で失敗しうる。")
        log(f"{purpose}用の一時領域: {d}（{label}, 空き {human(free)}, fs={ft}）")
        return d
    die(f"使える一時領域が無い（--{'tmp' if purpose == 'build' else 'spill'} で指定する）")


# ───────────────────────────── バンドル ─────────────────────────────

class Bundle:
    """出力ディレクトリ 1 個 = バンドル 1 個。viewer にはこのディレクトリを渡す。

        <out>/
          <name>.layered.db            本体
          <name>.layered.db.distill/   MSA 用（**実体ディレクトリ**。symlink にしない）
          <name>.layered.db.annot      アノテ（--band/--gene/--region 指定時）
          reads/                       リード実体（seekable zstd の GAF。--reads 指定時）
          manifest.json                版・能力・sha256
          work/                        中間物（typed/npz/pvst/tree）と log。部分やり直しに要る
          state.json                   段の完了記録（再開用）
    """

    def __init__(self, out: Path, name: str | None = None, gfa: Path | None = None):
        self.root = out.resolve()
        self.work = self.root / "work"
        self.logs = self.work / "log"
        self.name = name or self._infer_name(gfa)
        self.db = self.root / f"{self.name}.layered.db"
        self.distill = Path(str(self.db) + ".distill")
        self.annot = Path(str(self.db) + ".annot")
        self.reads_dir = self.root / "reads"
        self.state_path = self.root / "state.json"
        self.povu_dir = self.work / "povu"
        self.tree = self.work / "graph.tree"
        self.typed = self.work / "graph.typed"
        self.npz_prefix = self.work / "graph"          # layout は prefix を取り .npz を付ける
        self.npz = self.work / "graph.npz"
        self.dense_gfa = self.work / "dense.gfa"

    def _infer_name(self, gfa: Path | None) -> str:
        # 既存バンドルなら中の *.layered.db、次に state.json、無ければ GFA のファイル名から決める
        if self.root.is_dir():
            found = sorted(self.root.glob("*.layered.db"))
            if found:
                return found[0].name[: -len(".layered.db")]
            try:
                n = json.loads((self.root / "state.json").read_text()).get("name")
                if n:
                    return n
            except Exception:
                pass
        if gfa is None:
            die(f"--gfa も既存の DB も無いので名前が決まらない: {self.root}")
        n = gfa.name
        for suf in (".gz", ".gfa", ".gbz", ".vg"):
            if n.endswith(suf):
                n = n[: -len(suf)]
        return n

    def mkdirs(self):
        for d in (self.root, self.work, self.logs):
            d.mkdir(parents=True, exist_ok=True)

    # ── 状態 ──
    def load_state(self) -> dict:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text())
            except Exception:
                log(f"state.json が壊れているので作り直す: {self.state_path}")
        return {"state_version": STATE_VERSION, "name": self.name, "stages": {}}

    def save_state(self, st: dict):
        st["name"] = self.name
        st["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(st, indent=2, ensure_ascii=False) + "\n")
        tmp.replace(self.state_path)


# ───────────────────────────── 段の定義 ─────────────────────────────

class Stage:
    def __init__(self, name, cmds, inputs, outputs, env=None, note="", mkdirs=(), key_exclude=()):
        self.name = name
        # 鍵の計算から外すオプション（値が環境で変わるだけで**出力を変えない**もの）。
        # ここに入れないと「何も変えていないのに毎回やり直し」になる。
        self.key_exclude = set(key_exclude)
        self.mkdirs = list(mkdirs)    # 実行前に作るディレクトリ（作らない外部ツールがある）
        self.cmds = cmds              # [[argv], ...] 順に実行
        self.inputs = inputs          # [Path]
        self.outputs = outputs        # [Path]
        self.env = env or {}
        self.note = note

    def key(self) -> str:
        h = hashlib.sha1()
        for c in self.cmds:
            norm, skip = [], False
            for tok in map(str, c):
                if skip:                      # 直前が除外オプション → その値も飛ばす
                    skip = False
                    continue
                if tok in self.key_exclude:
                    skip = True
                    continue
                norm.append(tok)
            h.update(("\x00".join(norm) + "\n").encode())
        for k in sorted(self.env):
            h.update(f"{k}={self.env[k]}\n".encode())
        for p in self.inputs:
            h.update(f"{p}:{sig(Path(p))}\n".encode())
        return h.hexdigest()[:16]

    def outputs_ok(self) -> bool:
        """出力が揃っているか。要素が `*` を含む文字列なら glob（1 件以上で OK）として扱う。"""
        for o in self.outputs:
            if isinstance(o, str) and "*" in o:
                if not glob.glob(o):
                    return False
                continue
            p = Path(o)
            if not p.exists():
                return False
            if p.is_file() and p.stat().st_size == 0:
                return False
        return True

    def missing_inputs(self) -> list[str]:
        return [str(p) for p in self.inputs if sig(Path(p)) == "missing"]


def thread_env(n: int) -> dict:
    """BLAS 系のスレッド数を明示的に縛る。

    ★これを省くと**ジョブが起動しない**（実測）。OpenBLAS はノードのコア数(128)ぶん
    スレッドを作ろうとし、AGE のスロット制限下では pthread_create に失敗して
    「Importing the numpy C-extensions failed / PyCapsule_Import could not import module datetime」
    という**一見無関係なメッセージ**で numpy の import 自体が落ちる。
    """
    n = max(1, int(n))
    return {"OMP_NUM_THREADS": str(n), "OPENBLAS_NUM_THREADS": str(n),
            "MKL_NUM_THREADS": str(n), "NUMEXPR_NUM_THREADS": str(n),
            "VECLIB_MAXIMUM_THREADS": str(n)}


def build_stages(b: Bundle, a) -> dict:
    """段の仕様を作る。**遅延評価**（前段の出力を見て決まる部分があるため、実行直前に呼ぶ）。"""
    py = a.python
    threads = a.threads
    tmp = Path(a.tmp)
    spill = Path(getattr(a, "spill", None) or a.tmp)

    st: dict[str, Stage] = {}

    # ⓪ distill: GFA を 1 回だけ走査して dense-id numpy 中間にする。
    #    以降の段は GFA を再パースしない（WG では I/O 律速の主因だった）。
    #    --emit-dense-gfa は「dense≠identity のときだけ」書かれる → ① の入力選択に使う。
    if a.gfa:
        st["distill"] = Stage(
            "distill",
            [[py, str(PKG / "distill.py"), "--gfa", str(a.gfa),
              "--out", str(b.distill), "--emit-dense-gfa", str(b.dense_gfa)]],
            inputs=[a.gfa],
            outputs=[b.distill / "meta.json", b.distill / "p_tok.npy"],
            env=thread_env(1),
            note="GFA → dense-id numpy 中間（以降の段は GFA を読まない）",
        )

    # ① povu decompose: 元 GFA の整数 node id が必須。非 identity なら ⓠ が書いた dense GFA を使う。
    povu_gfa = b.dense_gfa if b.dense_gfa.exists() else (a.gfa or b.dense_gfa)
    st["decompose"] = Stage(
        "decompose",
        [[str(a.povu), "-v", "2", "-t", str(threads), "decompose",
          "-i", str(povu_gfa), "-o", str(b.povu_dir)]],
        inputs=[povu_gfa],
        outputs=[str(b.povu_dir / "*.pvst")],
        # ★povu は -o のディレクトリを自分では作らない。無いと
        #   「Could not open file …/1.pvst」で落ちる（成分検出まで進んでから落ちるので紛らわしい）。
        mkdirs=[b.povu_dir],
        note=f"バブル分解（povu）入力={povu_gfa.name}",
    )

    # ② 統一 LOD 木: **常に 1 スレッド**（Infomap の bit 再現性のため。速度ではなく仕様）。
    pvsts = sorted(glob.glob(str(b.povu_dir / "*.pvst")))
    st["lod"] = Stage(
        "lod",
        [[py, str(PKG / "lod.py"),
          "--distill", str(b.distill), "--pvst", *pvsts,
          "--B", "10", "--threads", "1", "--min-comp", str(a.min_comp),
          "--edge-weight", "hap", "--chain-ratio", "0",
          "--out", str(b.tree), "--dump-typed", str(b.typed)]],
        inputs=[b.distill, b.povu_dir],
        outputs=[b.typed],
        env=thread_env(1),
        note=f"統一 LOD 木（pvst {len(pvsts)} 本, 単スレ）",
    )

    # ③ レイアウト: topology-only SGD ＋ PivotMDS 初期化。真の多並列。
    st["layout"] = Stage(
        "layout",
        [[py, str(PKG / "layout.py"),
          "--distill", str(b.distill), "--out", str(b.npz_prefix),
          "--init", "pmds", "--epochs", str(a.epochs), "--seed", str(a.seed),
          "--min-comp", str(a.min_comp), "--pivots", str(a.pivots),
          "--pivot-mem-gib", str(a.mem_gib), "--threads", str(threads)]],
        inputs=[b.distill],
        outputs=[b.npz],
        env={**thread_env(threads), "NUMBA_NUM_THREADS": str(threads), "MPLBACKEND": "Agg"},
        # メモリ予算は「その機械で使える量」であって出力は変えない → 鍵から外す
        # （入れておくと、投入ノードが変わるたびに layout がやり直しになる）
        key_exclude=["--pivot-mem-gib"],
        note="向き付きレイアウト（pmds init）",
    )

    # ④ emit: 多層 DB 化。hapidx / nametri / emit-seq / contig リボンは emitter 既定 ON。
    #    ・--template は**スキーマ供給用**（内容は使わない。空テンプレを同梱している）
    #    ・--build-tmp / --ribbon-spill-dir は**ノードローカルの速いディスク**に置く
    #    ・--no-distill-sidecar: distill は最初からバンドル内の最終位置にあるので symlink を張らせない
    emit_cmd = [py, str(PKG / "emit.py"),
                "--schedule", "budget",
                "--typed", str(b.typed), "--npz", str(b.npz),
                "--distill", str(b.distill), "--no-distill-sidecar",
                "--template", str(a.template), "--out-db", str(b.db),
                # ★PID 等の毎回変わる値を入れない（コマンド行が変わると段の鍵が変わり、
                #   何も変えていないのに emit がやり直しになる）。バンドル名で一意にする。
                "--build-tmp", str(tmp / f"ggbprep-build-{b.name}"),
                "--emit-inversion", "--emit-multiplicity",
                "--budget-floor", "1000", "--budget-rmin", "2", "--budget-rmax", "2.5",
                "--budget-shrink", "0.8", "--budget-span-weight", "1.0",
                "--ref-key", a.ref_key]
    if a.ribbon_disk:
        emit_cmd += ["--ribbon-disk", "--ribbon-spill-dir", str(spill)]
    st["emit"] = Stage(
        "emit", [emit_cmd],
        inputs=[b.typed, b.npz, b.distill, a.template],
        outputs=[b.db],
        env=thread_env(1),
        note="多層 DB 化（hapidx/nametri/配列/リボンを内包）",
    )

    # アノテ（任意）: <db>.annot サイドカーへ書き、被覆索引を張る。DB 本体は不変。
    if a.band or a.gene or a.region:
        acmd = [py, str(PKG / "annotate.py"), str(b.db)]
        ins = [b.db]
        if a.band:
            acmd += ["--band", str(a.band)]
            ins.append(a.band)
        if a.gene:
            acmd += ["--gene", str(a.gene), "--gene-distill", str(b.distill),
                     "--gene-ref-path", a.gene_ref_path]
            ins.append(a.gene)
        if a.region:
            acmd += ["--region", str(a.region), "--region-ref", a.region_ref,
                     "--distill", str(b.distill)]
            ins.append(a.region)
        st["annot"] = Stage(
            "annot",
            [acmd, [py, str(PKG / "annot_index.py"), str(b.annot)]],
            inputs=ins,
            outputs=[b.annot],
            env=thread_env(1),
            note="アノテ（band/gene/region）→ サイドカー＋被覆索引",
        )

    # リード（任意）: オンデマンド。GAF を seekable zstd に詰め替え、索引だけをサイドカーに持つ。
    #   表示に使わない大きなタグ（既定 bq:Z=塩基クオリティ）は保存しない＝BGZF の 1/8 になる。
    if a.reads:
        rcmd = [py, str(PKG / "reads_attach.py"), str(b.db),
                "--out-dir", str(b.reads_dir), "--level", str(a.reads_level)]
        if a.reads_keep_tags:
            rcmd += ["--drop-tags", ""]
        ins = [b.db]
        for spec in a.reads:
            if "=" not in spec:
                die(f"--reads は SAMPLE=GAF の形で指定する: {spec}")
            sample, gaf = spec.split("=", 1)
            rcmd += ["--reads", f"{sample}={gaf}"]
            ins.append(Path(gaf))
        st["reads"] = Stage(
            "reads", [rcmd], inputs=ins, outputs=[b.reads_dir], env=thread_env(1),
            note=f"リード整列（{len(a.reads)} サンプル, オンデマンド索引）",
        )

    # manifest（最後に必ず作り直す）
    st["bundle"] = Stage(
        "bundle", [["<internal:manifest>"]], inputs=[b.db], outputs=[b.root / "manifest.json"],
        note="manifest.json（版・能力・sha256）",
    )
    return st


# ───────────────────────────── 実行 ─────────────────────────────

def run_cmd(cmd, log_path: Path, env_extra: dict, dry: bool) -> None:
    printable = " ".join(shlex.quote(str(c)) for c in cmd)
    if dry:
        print(f"  (dry-run) {printable}")
        return
    env = os.environ.copy()
    env.update({k: str(v) for k, v in env_extra.items()})
    log(f"$ {printable}")
    log(f"  log: {log_path}")
    t0 = time.time()
    with open(log_path, "ab") as lf:
        lf.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} {printable}\n".encode())
        lf.flush()
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        assert p.stdout is not None
        for raw in p.stdout:
            lf.write(raw)
            lf.flush()
            sys.stdout.write("    " + raw.decode(errors="replace"))
            sys.stdout.flush()
        rc = p.wait()
    if rc != 0:
        die(f"失敗 (rc={rc}): {printable}\n  ログ: {log_path}")
    log(f"  ok ({time.time() - t0:.1f}s)")


def write_manifest(b: Bundle, hash_limit_gb: float) -> None:
    import sqlite3
    con = sqlite3.connect(f"file:{b.db}?mode=ro", uri=True)
    meta = dict(con.execute("SELECT key,value FROM db_meta"))
    row = con.execute("SELECT maxlayer FROM stats LIMIT 1").fetchone()
    con.close()

    files = []
    for p in [b.db, b.annot] + sorted(b.root.glob(f"{b.db.name}.hapidx")) \
            + sorted(b.root.glob(f"{b.db.name}.nametri")) \
            + sorted(b.root.glob(f"{b.db.name}.reads")):
        if not p.exists():
            continue
        e = {"name": p.name, "bytes": p.stat().st_size}
        if e["bytes"] <= hash_limit_gb * 1e9:
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(8 << 20), b""):
                    h.update(chunk)
            e["sha256"] = h.hexdigest()
        else:
            e["sha256"] = None
            e["sha256_skipped"] = f"> {hash_limit_gb}GB (--hash-limit-gb で変更)"
        files.append(e)
    for d in (b.distill, b.reads_dir):
        if d.is_dir():
            tot = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
            files.append({"name": d.name, "kind": "dir", "bytes": tot})

    man = {
        "bundle_version": 1,
        "name": b.name,
        "db": b.db.name,
        "schema_version": int(meta.get("schema_version", 0)),
        "maxlayer": row[0] if row else None,
        "features": [x for x in meta.get("features", "").split(",") if x],
        "emitter_rev": meta.get("emitter_rev"),
        "db_built_at": meta.get("built_at"),
        "files": files,
        "total_bytes": sum(f["bytes"] for f in files),
        "built_by": "amipa-prep",
        "manifest_built_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    out = b.root / "manifest.json"
    out.write_text(json.dumps(man, indent=2, ensure_ascii=False) + "\n")
    log(f"manifest.json: {len(files)} files / {human(man['total_bytes'])}")


def execute(b: Bundle, a, want: list[str]) -> None:
    b.mkdirs()
    state = b.load_state()
    stages = build_stages(b, a)

    # 走らせる対象を決める（存在しない段＝入力が指定されていない任意段は飛ばす）
    plan = []
    for name in STAGES:
        if name not in stages or name not in want:
            continue
        plan.append(name)

    def is_fresh(name: str, s: Stage) -> bool:
        rec = state["stages"].get(name, {})
        return (rec.get("status") == "done" and rec.get("key") == s.key()
                and s.outputs_ok() and not a.force and name != "bundle")

    # 計画表示（★あくまで「今の時点での見込み」。前段が出力を書き換えれば後段は run に変わる）
    log(f"バンドル: {b.root}  (name={b.name})")
    print("  段        見込み 内容")
    for name in plan:
        print(f"  {name:<9} {'skip' if is_fresh(name, stages[name]) else 'run':<6} {stages[name].note}")
    if a.dry_run:
        log("--dry-run なので実行しない")
        for name in plan:
            if decisions[name] == "run":
                for c in stages[name].cmds:
                    print("   ", " ".join(shlex.quote(str(x)) for x in c))
        return

    for name in plan:
        # ★前段の出力に依存して中身が変わる段がある（① の入力 GFA、② の pvst 一覧）ので、
        #   実行直前に作り直す。判定も**ここで**やり直す：同じ実行の中で前段が出力を書き換えた
        #   場合、最初に立てた計画のままだと後段が「変更なし」と誤判定されて取り残される
        #   （例: emit をやり直したのに annot が古い DB のまま残る）。
        stages = build_stages(b, a)
        s = stages[name]
        if is_fresh(name, s):
            log(f"[{name}] 変更なし → 飛ばす")
            continue
        miss = s.missing_inputs()
        if miss:
            # ★manifest は「今あるものの目録」なので、本体がまだ無いのは**失敗ではない**。
            #   段別にジョブを投げる使い方（--only <段>）では毎回ここに来るので、
            #   die すると emit 前の段が軒並み「終了ステータス 1」に見えてしまう。
            if name == "bundle":
                log(f"[bundle] 本体がまだ無いので manifest は作らない（{', '.join(miss)}）")
                continue
            die(f"[{name}] 入力が無い: {', '.join(miss)}\n"
                f"  前の段をまだ走らせていないか、--out が違う可能性がある。"
                f"  `amipa prep status --out {b.root}` で確認する。")
        log(f"[{name}] {s.note}")
        for d in s.mkdirs:
            Path(d).mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        for c in s.cmds:
            if c[0] == "<internal:manifest>":
                write_manifest(b, a.hash_limit_gb)
            else:
                run_cmd(c, b.logs / f"{name}.log", s.env, a.dry_run)
        if not s.outputs_ok():
            die(f"[{name}] 出力が揃っていない: {[str(o) for o in s.outputs]}")
        state["stages"][name] = {
            "status": "done", "key": s.key(), "secs": round(time.time() - t0, 1),
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "outputs": [str(o) for o in s.outputs],
            "cmds": [[str(x) for x in c] for c in s.cmds],
        }
        # ★後段の記録は消さない。後段の鍵は「自分の入力ファイルの署名」を含むので、
        #   この段が実際に出力を書き換えたなら後段の鍵が自動的に変わって再実行される。
        #   一律に消すと、無関係な段（例: povu をやり直しただけなのに layout）まで無駄に走る。
        b.save_state(state)

    log("完了。viewer で開く例:")
    print(f"  apptainer exec --cleanenv -B {b.root}:/data ~/pangenome/ggb/sif/amipa-viewer.sif amipa check")


# ─────────────────────── 資源の見積り（plan） ───────────────────────

def sizing(gfa_bytes: int, threads: int, gaf_bytes: int = 0) -> dict:
    """段ごとの資源の目安。**HPRC MC-GRCh38 v1.0（GFA 48.3GB）の実測に合わせて較正**してある。

    実測 maxvmem / 実時間（= スケジューラのメモリ上限が縛る量。RSS ではない。2026-08-18 の通し）:
        distill  1 slot   0.4h   33.5G
        decompose 8 slots 0.8h  120.4G
        lod      1 slot   1.3h  109.6G
        layout  24 slots  1.0h   47.1G
        emit     1 slot   5.0h  115.6G
        annot    1 slot   2.0h   55.2G
        reads    8 slots  1.1h   28.3G   ← GAF 60.1GB(gz, HiFi 3 サンプル, 19.0M aln)
    reads だけは GFA ではなく **GAF の量**に比例する（葉ごとの転置索引をメモリに載せるため）。
    ここに **約 1.3-1.5 倍の余裕**を掛けた値を返す。グラフの密度で変わるので**あくまで出発点**。
    実行後に `qreport -j <ID>` 等で実測して詰めるのが正しい。

    メモリはジョブ全体の量(GB)で返す。スロットあたりで指定する必要がある環境では
    total / slots で割ること（`amipa prep plan` はその値も出す）。
    """
    g = gfa_bytes / 1e9
    q = gaf_bytes / 1e9          # リード整列(GAF.gz)の合計。reads 段だけはこちらに比例する
    t = max(1, threads)
    return {
        "distill":   dict(slots=1, total=clamp(1.0 * g, 8, 320), hours=0.2 + g / 140),
        "decompose": dict(slots=min(8, t), total=clamp(3.4 * g, 8, 400), hours=0.2 + g / 80),
        "lod":       dict(slots=1, total=clamp(3.1 * g, 8, 400), hours=0.2 + g / 45),
        "layout":    dict(slots=t, total=clamp(1.4 * g, 8, 300), hours=0.2 + g / 58),
        "emit":      dict(slots=1, total=clamp(3.3 * g, 24, 480), hours=0.2 + g / 10),
        "annot":     dict(slots=1, total=clamp(1.6 * g, 8, 200), hours=0.1 + g / 26),
        # reads は GFA ではなく **GAF の量**で決まる（葉ごとの転置索引をメモリに持つため）。
        # 実測: GAF.gz 60.1GB / 葉 8140 万 / のべ通過 52.8 億回 → 28.3G・1.1h。
        # 通過を delta+varint でその場で畳むので、GAF.gz 1GB あたり ~0.47GB に収まる。
        "reads":     dict(slots=1, total=clamp(0.7 * q + 0.1 * g, 8, 300),
                          hours=0.2 + q / 50),
        "bundle":    dict(slots=1, total=8, hours=0.1),
    }


def show_plan(b: Bundle, a) -> None:
    """段ごとの資源の目安を出す。**ジョブスクリプトは利用者が自分の環境の書式で書く**。

    ここが出すのは「何スロット・どれだけメモリ・だいたい何時間」という中身の話だけで、
    スケジューラの構文には踏み込まない（サイトごとに違うため）。雛形は examples/hpc/ にある。
    """
    gfa_bytes = a.gfa.stat().st_size if a.gfa else 0
    gaf_bytes = 0
    for spec in (a.reads or []):
        pth = Path(spec.split("=", 1)[1]) if "=" in spec else None
        if pth and pth.exists():
            gaf_bytes += pth.stat().st_size
    size = sizing(gfa_bytes, a.threads, gaf_bytes)
    stages = [n for n in STAGES if n in build_stages(b, a)]
    if a.json:
        out = {n: {**size[n], "per_slot": -(-size[n]["total"] // size[n]["slots"])} for n in stages}
        print(json.dumps({"gfa_bytes": gfa_bytes, "gaf_bytes": gaf_bytes,
                          "threads": a.threads, "stages": out},
                         indent=2, ensure_ascii=False))
        return
    log(f"入力 GFA {human(gfa_bytes)}"
        + (f" / GAF {human(gaf_bytes)}" if gaf_bytes else "")
        + f" / --threads {a.threads} での目安")
    print(f"  {'段':<10} {'スロット':>7} {'メモリ合計':>10} {'/スロット':>9} {'見込み時間':>10}")
    for n in stages:
        v = size[n]
        per = -(-v["total"] // v["slots"])
        print(f"  {n:<10} {v['slots']:>7} {str(v['total']) + 'G':>10} {str(per) + 'G':>9} {v['hours']:>9.1f}h")
    print()
    print("  ・HPRC MC-GRCh38 v1.0(GFA 48.3GB / GAF 60.1GB)の実測に 1.3-1.5 倍の余裕を掛けた値。"
          "グラフの密度で変わるので出発点として使い、1 度流したら実測で詰めること")
    print("  ・スロットあたりで指定する環境（例: AGE の s_vmem）では「/スロット」の列を使う")
    print("  ・ジョブスクリプトの雛形は examples/hpc/ を参照（中で `amipa prep run --only <段>` を呼ぶ）")


# ───────────────────────────── CLI ─────────────────────────────

def add_common(p, need_gfa=False):
    p.add_argument("--out", required=True, type=Path, help="バンドル（出力ディレクトリ）")
    p.add_argument("--gfa", type=Path, required=need_gfa, help="入力 GFA")
    p.add_argument("--name", help="DB のベース名（既定: GFA 名 or 既存 DB 名）")
    p.add_argument("--threads", type=int, default=len(os.sched_getaffinity(0)),
                   help="並列度（②は決定性のため常に 1）")
    p.add_argument("--spill", default=os.environ.get("AMIPA_SPILL"),
                   help="リボン/多重度の disk streaming(spill)の置き場（既定 = --tmp と同じ）。"
                        "**順次書きなので共有FSでも実害が小さく、必要量は DB より桁違いに大きいことがある**"
                        "（MC v2 実測で最大 2.3TB）。ノードローカルに入らない規模ではここだけ共有FSへ逃がす")
    p.add_argument("--tmp", default=os.environ.get("AMIPA_TMP") or os.environ.get("GGB_TMP"),
                   help="④のビルド用一時領域（既定: $TMPDIR → /tmp → <out>/work/tmp のうち"
                        "空きが足りる最初のもの）。**ノードローカルの速いディスク**が望ましい")
    p.add_argument("--mem-gib", type=float, default=None, help="③の pivot メモリ予算（既定 MemAvailable の 60%%）")
    p.add_argument("--template", type=Path, default=Path(os.environ.get("GGB_TEMPLATE_DB", DEFAULT_TEMPLATE)),
                   help="④のスキーマ供給用 DB（既定は同梱の空テンプレ）")
    p.add_argument("--povu", type=Path, default=Path(os.environ.get("GGB_POVU", DEFAULT_POVU)))
    p.add_argument("--python", default=sys.executable)
    p.add_argument("--ref-key", default="GRCh38", help="参照座標に使うパスの sample key")
    p.add_argument("--min-comp", type=int, default=1000)
    p.add_argument("--epochs", type=int, default=30)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--pivots", type=int, default=400)
    p.add_argument("--ribbon-disk", action="store_true",
                   help="リボンを disk streaming で作る（大きいグラフ。RAM を O(node) に抑える）")
    p.add_argument("--band", type=Path, help="cytoBand（GRCh38）")
    p.add_argument("--gene", type=Path, help="GENCODE GTF")
    p.add_argument("--gene-ref-path", default="grch38")
    p.add_argument("--region", type=Path, help="領域 BED（CHM13 座標）")
    p.add_argument("--region-ref", default="chm13")
    p.add_argument("--reads", action="append", metavar="SAMPLE=GAF", help="リード整列（複数指定可）")
    p.add_argument("--reads-level", type=int, default=9,
                   help="リード実体の zstd 圧縮レベル（既定 9）。上げると容量は減るが構築が遅くなる"
                        "（閲覧側は遅くならない）")
    p.add_argument("--reads-keep-tags", action="store_true",
                   help="GAF のタグを全部保存する（既定は表示に使わない bq:Z を捨てる）")
    p.add_argument("--hash-limit-gb", type=float, default=2.0,
                   help="manifest で sha256 を計算する上限サイズ（既定 2GB。大きい DB は省略）")
    p.add_argument("--force", action="store_true", help="全段やり直す")
    p.add_argument("--dry-run", action="store_true", help="コマンドを表示するだけ")


def main():
    ap = argparse.ArgumentParser(prog="amipa prep", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="一気通貫（または --only/--from で部分実行）")
    add_common(p_run)
    p_run.add_argument("--from", dest="from_stage", choices=STAGES, help="この段以降をやり直す")
    p_run.add_argument("--only", dest="only_stage", choices=STAGES, help="この段だけ実行")

    p_st = sub.add_parser("status", help="段の状態を表示")
    p_st.add_argument("--out", required=True, type=Path)

    p_an = sub.add_parser("add-annot", help="既存バンドルにアノテを足す（DB は作り直さない）")
    add_common(p_an)

    p_rd = sub.add_parser("add-reads", help="既存バンドルにリード整列を足す")
    add_common(p_rd)

    p_pl = sub.add_parser("plan", help="段ごとの資源の目安を出す（ジョブスクリプトは利用者が書く）")
    add_common(p_pl, need_gfa=True)
    p_pl.add_argument("--json", action="store_true", help="JSON で出す")

    a = ap.parse_args()

    if a.cmd == "status":
        b = Bundle(a.out)
        st = b.load_state()
        print(f"bundle: {b.root}  name={st.get('name')}  updated={st.get('updated_at','-')}")
        print(f"  {'段':<10} {'状態':<8} {'秒':>9}  終了時刻")
        for name in STAGES:
            rec = st["stages"].get(name)
            if not rec:
                print(f"  {name:<10} {'-':<8}")
                continue
            print(f"  {name:<10} {rec['status']:<8} {rec.get('secs', 0):>9.1f}  {rec.get('finished_at','')}")
        for extra in ("manifest.json",):
            print(f"  {extra}: {'あり' if (b.root / extra).exists() else 'なし'}")
        return

    # 入力パスは絶対化する（ジョブスクリプトは投入時とは別の cwd で走りうる）
    for attr in ("gfa", "band", "gene", "region", "template", "povu"):
        v = getattr(a, attr, None)
        if v:
            setattr(a, attr, Path(v).resolve())
    if a.reads:
        a.reads = [f"{s.split('=', 1)[0]}={Path(s.split('=', 1)[1]).resolve()}" if "=" in s else s
                   for s in a.reads]
    if a.tmp:                       # 未指定なら後段の resolve_tmp が決める
        a.tmp = str(Path(a.tmp).resolve())

    # 既定値の補完。★環境で変わる値は記録に焼き込まない
    a.mem_explicit = a.mem_gib is not None
    a.tmp_explicit = a.tmp is not None
    a.spill_explicit = getattr(a, "spill", None) is not None
    if a.mem_gib is None:
        a.mem_gib = round(mem_available_gib() * 0.6, 1)
    b = Bundle(a.out, a.name, a.gfa)

    # 一時領域を決める（明示が無ければ $TMPDIR → /tmp → <out>/work/tmp から空きで選ぶ）
    a.tmp = str(resolve_tmp(a.tmp, Path(a.out).resolve(), a.gfa, purpose="build"))
    # spill は明示が無ければ build と同じ場所（小さいグラフではこれで足りる）
    a.spill = str(resolve_tmp(a.spill or a.tmp, Path(a.out).resolve(), a.gfa,
                              purpose="spill", need_factor=6.0))
    if not Path(a.template).exists():
        die(f"--template が無い: {a.template}（emitter はスキーマ供給用の DB を要る）")

    if a.cmd == "plan":
        show_plan(b, a)
        return

    if a.cmd == "add-annot":
        if not (a.band or a.gene or a.region):
            die("--band / --gene / --region のいずれかを指定する")
        execute(b, a, ["annot", "bundle"])
        return
    if a.cmd == "add-reads":
        if not a.reads:
            die("--reads SAMPLE=GAF を指定する")
        execute(b, a, ["reads", "bundle"])
        return

    # run
    want = list(STAGES)
    if a.only_stage:
        want = [a.only_stage]
        if a.only_stage != "bundle":
            want.append("bundle")
    elif a.from_stage:
        i = STAGES.index(a.from_stage)
        want = STAGES[i:]
        # やり直す起点より後の記録を捨てて確実に再実行させる
        state = b.load_state()
        for name in STAGES[i:]:
            state["stages"].pop(name, None)
        b.mkdirs()
        b.save_state(state)
    execute(b, a, want)


if __name__ == "__main__":
    main()
