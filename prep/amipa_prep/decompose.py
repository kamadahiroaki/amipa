#!/usr/bin/env python3
"""decompose.py — バブル分解器を呼び、結果を lod.py が読む pvst 形式に揃える。

  decompose.py --tool billi        --gfa G --out DIR [--tmp T] [--threads N]
  decompose.py --tool bubblefinder --gfa G --out DIR [--tmp T] [--threads N]

出力は DIR/1.pvst（`H` 行、`D 0 . <最上位の子>`、`F <idx> >a>z <子> L`。以前使っていた povu の形式）。
lod.py が使うのは各バブルの向き付きの入口・出口と親子関係だけなので、分解器はこれを満たせば差し替えられる。

分解器（2026-11-13〜16 の比較。amipa-lab/notes/bubble_detector_RESULTS.md）:
  bubblefinder … BubbleFinder `ultrabubbles --clsd-trees`。既定。最も速く軽い（全ゲノム pggb 109 s / 26 GB）が、
                 内部に閉路を含むバブルは ultrabubble の定義から外れるので出さない（pggb・細菌で被覆 2〜6 % 減、
                 そのバブルは lod の木で 2〜17 片に割れる）。GPL-3.0、イメージに同梱。
  billi        … Billi（panbubble）。閉路を含むバブルも出し、入れ子もより正しい。全ゲノム pggb で 502 s / 68 GB。
                 1 スレッド。リポジトリにライセンスの表示が無く再配布できないので、イメージには同梱しない。
（以前の既定 povu は全ゲノム pggb で 3,724 s / 167 GB かかり、2026-11-16 に外した。）

入力からは P/W 行を除いて渡す（パスは分解に要らず、Billi はパスがあるとアレルのウォークまで数える）。
Billi・BubbleFinder とも、端（tip）の無い連結成分（純粋な環）があると止まる。そのときだけ、成分ごとに
分岐の無いノード v を v と v′ に割って環を開き（左側の辺を v′ へ付け替える）、やり直す。結果の v′ は v に戻す。
"""
from __future__ import annotations
import argparse
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)


def strip_paths(gfa: Path, out: Path) -> None:
    """P/W 行を除いた GFA を書く（S/L/H だけ）。"""
    with open(gfa, "rb") as f, open(out, "wb") as o:
        for line in f:
            if line[:1] in (b"P", b"W"):
                continue
            o.write(line)


# ---------------------------------------------------------------- 端の無い成分を開く
def open_tipless_components(gfa: Path, out: Path) -> dict:
    """端の無い連結成分ごとにノード v を v と v′ に割り、環を線に開いた GFA を書く。返り値 {v′: v}。"""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    ids = []
    ea, eb, sa, sb = [], [], [], []
    with open(gfa) as f:
        for line in f:
            if line[0] == "S":
                ids.append(int(line.split("\t", 2)[1]))
            elif line[0] == "L":
                p = line.split("\t", 5)
                ea.append(int(p[1])); sa.append(1 if p[2] == "+" else 0)   # a の使う側（1=右）
                eb.append(int(p[3])); sb.append(0 if p[4] == "+" else 1)   # b の使う側（0=左）
    ids = np.array(ids, np.int64); ids.sort()
    ea = np.searchsorted(ids, np.array(ea, np.int64)); eb = np.searchsorted(ids, np.array(eb, np.int64))
    sa = np.array(sa, np.int8); sb = np.array(sb, np.int8)
    n = ids.size
    deg = np.zeros((n, 2), np.int64)
    np.add.at(deg, (ea, sa), 1); np.add.at(deg, (eb, sb), 1)
    g = coo_matrix((np.ones(ea.size, np.int8), (ea, eb)), shape=(n, n))
    ncomp, lab = connected_components(g, directed=False)
    tip = (deg[:, 0] == 0) | (deg[:, 1] == 0)
    has_tip = np.zeros(ncomp, bool); has_tip[lab[tip]] = True
    bad = np.flatnonzero(~has_tip)
    log(f"  端の無い成分 {bad.size} / {ncomp}")
    # 成分ごとに割るノード: 分岐の無い鎖の上のノードを選ぶ。左右とも辺 1 本で、その辺の相手側も辺 1 本
    # （＝両隣とも分岐していない）。バブルのアレルの途中（隣が分岐点）を割ると、そのバブルが壊れる。
    simple = (deg[:, 0] == 1) & (deg[:, 1] == 1)
    eok = (deg[ea, sa] == 1) & (deg[eb, sb] == 1) & (ea != eb)
    nok = np.zeros(n, np.int64); np.add.at(nok, ea[eok], 1); np.add.at(nok, eb[eok], 1)
    chain = simple & (nok == 2)
    cut = {}
    for c in bad:
        mem = np.flatnonzero(lab == c)
        s = mem[chain[mem]]
        if not s.size:
            s = mem[simple[mem]]
        v = int(s[0]) if s.size else int(mem[np.argmin(deg[mem].sum(1))])
        cut[v] = None
    nxt = int(ids.max()) + 1
    remap = {}
    for v in sorted(cut):
        cut[v] = nxt; remap[nxt] = int(ids[v]); nxt += 1
    cut_id = {int(ids[v]): w for v, w in cut.items()}     # GFA の id -> v′
    with open(gfa) as f, open(out, "w") as o:
        for line in f:
            if line[0] == "L":
                p = line.rstrip("\n").split("\t")
                a, b = int(p[1]), int(p[3])
                if a in cut_id and p[2] == "-":            # a の左側から出る辺
                    p[1] = str(cut_id[a])
                if b in cut_id and p[4] == "+":            # b の左側へ入る辺
                    p[3] = str(cut_id[b])
                o.write("\t".join(p) + "\n")
            else:
                o.write(line)
        for v, w in cut_id.items():
            o.write(f"S\t{w}\tN\n")
    return remap


def run(cmd, log_path, stdout_path=None):
    log("  $", " ".join(map(str, cmd)))
    with open(log_path, "ab") as lg:
        if stdout_path is None:
            return subprocess.run(cmd, stdout=lg, stderr=lg).returncode
        with open(stdout_path, "wb") as so:
            return subprocess.run(cmd, stdout=so, stderr=lg).returncode


def _rid(x: str, remap: dict) -> str:
    return str(remap.get(int(x), int(x))) if remap else x


# ---------------------------------------------------------------- Billi -> pvst
def _billi_cols(txt: Path) -> tuple:
    """BB 行の列の位置を `CC\tBB\t...` のヘッダーから読む（版で列が増えた: 2026-08 に bbDpt が parID の前に入った）。"""
    with open(txt) as f:
        for line in f:
            if line.startswith("CC\tBB\t"):
                h = line.rstrip("\n").split("\t")[1:]          # BB bbID [bbDpt] parID side1 side2 #alleles
                return h.index("bbID"), h.index("parID"), h.index("side1"), h.index("side2")
            if line.startswith("BB\t"):
                break
    return 1, 2, 3, 4


def billi_to_pvst(txt: Path, out: Path, remap: dict) -> dict:
    """Billi の BB 行（bbID [bbDpt] parID side1 side2 #alleles）を pvst に。parID が BB:<id> なら親、HP:<id>（hairpin）と -1 は最上位。
    side1/side2 はそのまま pvst の >a>z になる（以前の povu と向きが全件一致することを chrY〜全ゲノムで確認済み）。"""
    cI, cP, c1, c2 = _billi_cols(txt)
    bid, par, degen = [], [], []
    with open(txt) as f:
        for line in f:
            if not line.startswith("BB\t"):
                continue
            p = line.rstrip("\n").split("\t")
            bid.append(int(p[cI]))
            q = p[cP]
            par.append(int(q[3:]) if q.startswith("BB:") else -1)
            # 環を開いたとき、開いた位置をまたぐバブルは入口と出口が同じノード（v と v′）になる。退化なので落とす
            degen.append(bool(remap) and _rid(p[c1][1:], remap) == _rid(p[c2][1:], remap))
    bid = np.array(bid, np.int64); par = np.array(par, np.int64); degen = np.array(degen, bool)
    order = np.argsort(bid, kind="stable"); sbid = bid[order]
    if sbid.size and np.any(sbid[1:] == sbid[:-1]):
        raise SystemExit("Billi の出力に重複した bbID がある")
    fid = np.empty(bid.size, np.int64); fid[order] = np.arange(1, bid.size + 1)   # 出現順でなく bbID 順に 1..n
    pidx = np.full(bid.size, 0, np.int64)                                           # 親の F 番号（0=最上位）
    hasp = par >= 0
    pos = np.searchsorted(sbid, par[hasp])
    ok = (pos < sbid.size) & (sbid[np.minimum(pos, sbid.size - 1)] == par[hasp])
    tmp = np.zeros(hasp.sum(), np.int64); tmp[ok] = fid[order[pos[ok]]]
    pidx[hasp] = tmp
    # 退化バブルを落とす: 番号を詰め直し、その子は親の親へ
    if degen.any():
        keepf = np.ones(bid.size + 1, bool); keepf[fid[degen]] = False   # F 番号で
        par_of_f = np.zeros(bid.size + 1, np.int64); par_of_f[fid] = pidx
        for i in range(bid.size):
            q = pidx[i]
            while q != 0 and not keepf[q]:
                q = par_of_f[q]
            pidx[i] = q
        newf = np.zeros(bid.size + 1, np.int64); newf[keepf] = np.arange(int(keepf.sum())); newf[0] = 0
        fid = newf[fid]; pidx = newf[pidx]
        fid[degen] = -1
    # 子の並び（CSR）
    live = fid > 0
    ko = np.flatnonzero(live)[np.argsort(pidx[live], kind="stable")]
    kstart = np.searchsorted(pidx[ko], np.arange(bid.size + 2))
    def kids(f):
        sl = ko[kstart[f]:kstart[f + 1]]
        return ",".join(map(str, fid[sl])) if sl.size else "."
    nhp = 0
    with open(txt) as f, open(out, "w") as o:
        o.write("H\tbilli\t.\t.\t.\n")
        o.write(f"D\t0\t.\t{kids(0)}\t.\n")
        i = 0
        for line in f:
            if not line.startswith("BB\t"):
                continue
            p = line.rstrip("\n").split("\t")
            if fid[i] < 0:
                i += 1
                continue
            nhp += p[cP].startswith("HP:")
            s1, s2 = p[c1], p[c2]
            if remap:
                s1 = s1[0] + _rid(s1[1:], remap); s2 = s2[0] + _rid(s2[1:], remap)
            o.write(f"F\t{fid[i]}\t{s1}{s2}\t{kids(int(fid[i]))}\tL\n")
            i += 1
    return {"bubbles": int((fid > 0).sum()), "top": int(((pidx == 0) & (fid > 0)).sum()),
            "hairpin_parent_to_top": int(nhp), "dropped_degenerate": int(degen.sum())}


# ---------------------------------------------------------------- BubbleFinder -> pvst
TOK = re.compile(r"\(|\)|,|<([^,>]+),([^>]+)>")


def bubblefinder_to_pvst(clsd: Path, ub: Path, out: Path, remap: dict) -> dict:
    """BubbleFinder の --clsd-trees（1 行 1 木。葉 <X,Y>、内部 (子,...)<X,Y>）を pvst に。
    符号は「そのノードのどちら側にバブルの内部があるか」（+ = 右, - = 左）。入口 a は内部が右なら '>'、
    出口 z は内部が左なら '>'（そこへ順向きに入る）。以前の povu と向きが全件一致することを確認済み。
    木は superbubble の木で、ultrabubble 以外（ほぼ全部が隣接する ID の自明バブル）を含む。
    ultrabubbles の集合に無い項目は落とし、その子を一段上へつなぐ。木に無い ultrabubble は最上位に置く。"""
    num = lambda s: int(s[:-1])
    key = lambda x, y: (min(num(x), num(y)), max(num(x), num(y)))
    ubk = {}
    with open(ub) as f:
        f.readline()
        for line in f:
            x, y = line.split()[:2]
            ubk[key(x, y)] = (x, y)
    rows = []                     # [x, y, parent_row]
    with open(clsd) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            stack = [[]]
            for m in TOK.finditer(line):
                t = m.group(0)
                if t == "(":
                    stack.append([])
                elif t in "),":
                    pass
                else:
                    idx = len(rows); rows.append([m.group(1), m.group(2), -1])
                    if m.start() > 0 and line[m.start() - 1] == ")":
                        for c in stack.pop():
                            rows[c][2] = idx
                    stack[-1].append(idx)
    keep = [key(x, y) in ubk and not (remap and _rid(x[:-1], remap) == _rid(y[:-1], remap)) for x, y, _ in rows]

    def up(i):
        p = rows[i][2]
        while p >= 0 and not keep[p]:
            p = rows[p][2]
        return p
    fid = {}; outl = []; seen = set()
    for i, (x, y, _) in enumerate(rows):
        kk = key(x, y)
        if keep[i] and kk not in seen:
            seen.add(kk); fid[i] = len(outl) + 1; outl.append(i)
    extra = [v for kk, v in ubk.items() if kk not in seen
             and not (remap and _rid(v[0][:-1], remap) == _rid(v[1][:-1], remap))]
    kids = {0: []}
    for i in outl:
        p = up(i)
        kids.setdefault(fid[p] if p >= 0 else 0, []).append(fid[i])
    nf = len(outl)
    for j in range(len(extra)):
        kids[0].append(nf + 1 + j)

    def bnd(x, y):
        a = (">" if x[-1] == "+" else "<") + _rid(x[:-1], remap)
        z = (">" if y[-1] == "-" else "<") + _rid(y[:-1], remap)
        return a + z
    with open(out, "w") as o:
        o.write("H\tbubblefinder\t.\t.\t.\n")
        o.write("D\t0\t.\t" + (",".join(map(str, kids[0])) or ".") + "\t.\n")
        for i in outl:
            x, y, _ = rows[i]; f = fid[i]
            o.write(f"F\t{f}\t{bnd(x, y)}\t{','.join(map(str, kids.get(f, []))) or '.'}\tL\n")
        for j, (x, y) in enumerate(extra):
            o.write(f"F\t{nf + 1 + j}\t{bnd(x, y)}\t.\tL\n")
    return {"tree_entries": len(rows), "bubbles": nf + len(extra), "dropped_non_ultrabubble": len(rows) - nf,
            "ultrabubble_not_in_tree": len(extra), "top": len(kids[0])}


# ---------------------------------------------------------------- 本体
def detect(tool: str, gfa: Path, outdir: Path, work: Path, threads: int, exe: str, logp: Path) -> tuple:
    """分解器を 1 回走らせる。返り値 (成功したか, 生の出力のパス群)。"""
    if tool == "billi":
        raw = work / "billi.txt"
        rc = run([exe, "decompose", "-w", "-i", str(gfa)], logp, raw)     # -w: アレルのウォークを出さない（速い）
        return rc == 0, (raw,)
    clsd, ub = work / "clsd.txt", work / "ultrabubbles.txt"
    rc = run([exe, "ultrabubbles", "-g", str(gfa), "--gfa", "-j", str(threads), "-o", str(ub), "--clsd-trees", str(clsd)], logp)
    return rc == 0 and ub.exists() and clsd.exists(), (clsd, ub)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tool", choices=("billi", "bubblefinder"), required=True)
    ap.add_argument("--gfa", required=True, type=Path, help="整数 ID の GFA（prep の dense.gfa など）")
    ap.add_argument("--out", required=True, type=Path, help="出力ディレクトリ（1.pvst を書く）")
    ap.add_argument("--tmp", type=Path, default=None, help="一時ファイル（P/W 行を除いた GFA など）の置き場")
    ap.add_argument("--threads", type=int, default=1, help="BubbleFinder のスレッド数（Billi は 1 スレッド）")
    ap.add_argument("--exe", default=None, help="分解器の実行ファイル（既定 AMIPA_BILLI / AMIPA_BUBBLEFINDER か PATH 上）")
    ap.add_argument("--keep-raw", action="store_true", help="分解器の生の出力を DIR/raw/ に残す")
    a = ap.parse_args()
    exe = a.exe or os.environ.get("AMIPA_BILLI" if a.tool == "billi" else "AMIPA_BUBBLEFINDER") \
        or ("billi" if a.tool == "billi" else "BubbleFinder")
    if shutil.which(exe) is None and not Path(exe).exists():
        raise SystemExit(f"{a.tool} の実行ファイルが見つからない: {exe}（--exe か AMIPA_{'BILLI' if a.tool == 'billi' else 'BUBBLEFINDER'} で指定）")
    a.out.mkdir(parents=True, exist_ok=True)
    for old in a.out.glob("*.pvst"):
        old.unlink()
    work = Path(a.tmp or a.out) / f"decompose.{a.tool}.{os.getpid()}"
    work.mkdir(parents=True, exist_ok=True)
    logp = a.out / f"{a.tool}.log"
    logp.write_text("")
    t0 = time.time()
    try:
        g = work / "g.gfa"
        log(f"{a.tool}: P/W 行を除く {a.gfa}")
        strip_paths(a.gfa, g)
        ok, raw = detect(a.tool, g, a.out, work, a.threads, exe, logp)
        remap = {}
        if not ok:
            msg = logp.read_text(errors="replace")[-2000:]
            log(f"{a.tool} が失敗。端の無い成分を開いてやり直す（ログ末尾: {msg.strip().splitlines()[-1] if msg.strip() else '-'}）")
            g2 = work / "g.open.gfa"
            remap = open_tipless_components(g, g2)
            if not remap:
                raise SystemExit(f"{a.tool} が失敗した（端の無い成分は無い）。ログ: {logp}")
            ok, raw = detect(a.tool, g2, a.out, work, a.threads, exe, logp)
            if not ok:
                raise SystemExit(f"{a.tool} が環を開いても失敗した。ログ: {logp}")
            log(f"  環を開いた成分 {len(remap)}（割ったノード {sorted(remap.values())[:5]}…）")
        t1 = time.time()
        log(f"{a.tool} 完了 {t1 - t0:.0f} s。pvst に変換")
        pv = a.out / "1.pvst"
        info = billi_to_pvst(raw[0], pv, remap) if a.tool == "billi" else bubblefinder_to_pvst(raw[0], raw[1], pv, remap)
        info["opened_components"] = len(remap)
        log(f"変換 {time.time() - t1:.0f} s: {info}")
        if a.keep_raw:
            (a.out / "raw").mkdir(exist_ok=True)
            for r in raw:
                shutil.move(str(r), a.out / "raw" / r.name)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
