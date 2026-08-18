#!/usr/bin/env python3
"""
reads_query.py — オンデマンドのリード照会ヘルパ。backend(Node/TS)から起動され、
索引(node_reads/read_aln/read_src)＋**seekable zstd の GAF**（旧アトラスは BGZF）から
必要な行だけ取り出して parse し、JSON を返す。

cs スライス等のロジックは前処理側と共有(二重実装回避)。1リクエスト=1プロセス(常駐しない)。

モード:
  --node nX [--sample S] [--region A-B] [--end-margin M --ends-over K] [--max N]
        Q1: そのノードへの塩基レベルリードアライン(cs 付き)。 → {"reads":{"nX":[...]},"totals":{"nX":n}}
  --expand nX [--sample S] [--max N]
        Q2: 上記リード群の全通過ノード(行内で取得)。 → {"reads":{...cohort by node...}}
  --search Q [--limit L]
        Q3/検索: read_name(前方一致)or aln_id → 各アライメントの通過セグメント。 → {"results":[...]}
  --aln ID
        1 aln_id の通過セグメント。 → {"results":[{aln_id,segments:[...]}]}

出力は stdout に JSON 1 行。
"""
import sys, os, re, json, sqlite3, argparse
_HERE = os.path.dirname(os.path.abspath(__file__))
# 共有モジュール(cs_ops / zstd_seek)は前処理側が正。イメージではビルド時に隣へ複製されるが、
# リポジトリ直実行（開発時）では prep/amipa_prep にしか無いので両方見る。
sys.path[:0] = [_HERE, os.path.join(_HERE, "..", "..", "prep", "amipa_prep")]
from cs_ops import extract_node_cs, cs_to_cigar, extract_node_cigar  # cs ロジック共有(numpy 非依存)

TOK = re.compile(r'([<>])(\d+)')


def _decode_postings(blob):
    """node_reads.postings(delta+LEB128 varint)→ aln_id 昇順リスト。Rust/py の write_varint と対。"""
    out = []; prev = 0; shift = 0; cur = 0
    for byte in blob:
        cur |= (byte & 0x7f) << shift
        if byte & 0x80:
            shift += 7
        else:
            prev += cur; out.append(prev); cur = 0; shift = 0
    return out


def attach_sidecar(con, db_path, sidecar=None):
    """read 索引サイドカー(<db>.reads 既定)を rd として ATTACH。無ければ base 自身に read 表がある
    レガシー単一 DB とみなし、rd を base の別名として使う(後方互換)。"""
    if sidecar is None:
        cand = db_path + ".reads"
        sidecar = cand if os.path.exists(cand) else None
    if sidecar and os.path.exists(sidecar):
        con.execute("ATTACH DATABASE ? AS rd", (sidecar,))
        return True
    # フォールバック: base 自身に read 表(レガシー)。rd = main の別名として ATTACH。
    con.execute("ATTACH DATABASE ? AS rd", (db_path,))
    return False


def parse_gaf_line(line):
    c = line.rstrip("\n").split("\t")
    if len(c) < 12:
        return None
    d = {"read_name": c[0], "query_len": int(c[1]), "q_start": int(c[2]), "q_end": int(c[3]),
         "path": c[5], "path_start": int(c[7]), "path_end": int(c[8]),
         "mapq": (int(c[11]) if c[11] != "*" else None), "is_primary": 1, "cg": None, "cs": None}
    for t in c[12:]:
        if t.startswith("tp:A:"): d["is_primary"] = 1 if t == "tp:A:P" else 0
        elif t.startswith("cg:Z:"): d["cg"] = t[5:]
        elif t.startswith("cs:Z:"): d["cs"] = t[5:]
    return d


def walk_nodes(d, size_of):
    """path を展開し (gfa_id, strand, offset, seg) を順に yield。offset=パス累積座標。"""
    off = 0
    for m in TOK.finditer(d["path"]):
        gid = int(m.group(2)); strand = '+' if m.group(1) == '>' else '-'
        seg = size_of.get(gid, 0)
        if seg == 0:
            continue
        yield gid, strand, off, seg
        off += seg


def node_record(d, gid, strand, off, seg):
    """target ノードの per-node レコード(cs 付き)を作る。範囲外なら None。"""
    ps, pe = d["path_start"], d["path_end"]
    a0 = max(ps, off); a1 = min(pe, off + seg)
    if a1 <= a0:
        return None
    pls, ple = a0 - off, a1 - off
    if strand == '+':
        ns, ne = pls, ple
    else:
        ns, ne = seg - ple, seg - pls
    apl = pe - ps; qal = d["q_end"] - d["q_start"]
    if apl > 0:
        nqs = d["q_start"] + round((a0 - ps) / apl * qal)
        nqe = d["q_start"] + round((a1 - ps) / apl * qal)
    else:
        nqs, nqe = d["q_start"], d["q_end"]
    ncs = extract_node_cs(d["cs"], ps, a0, a1, strand) if d["cs"] else None
    cig = cs_to_cigar(ncs) if ncs is not None else extract_node_cigar(d["cg"], ps, a0, a1, strand)
    return {"read_name": d["read_name"], "node_start": ns, "node_end": ne,
            "query_start": nqs, "query_end": nqe, "query_len": d["query_len"],
            "strand": strand, "mapq": d["mapq"], "is_primary": d["is_primary"],
            "cigar": cig, "cs": ncs, "node_name": f"n{gid}"}


def sizes_for(con, gids):
    """gfa_id 群のノードサイズを nodes.size(葉 n{id})から一括取得。"""
    out = {}
    gids = list(gids)
    for i in range(0, len(gids), 900):
        chunk = gids[i:i+900]
        ph = ",".join("?" * len(chunk))
        for nm, sz in con.execute(
                f"SELECT node_name,size FROM nodes WHERE node_name IN ({ph})",
                [f"n{g}" for g in chunk]):
            out[int(nm[1:])] = int(sz) if sz else 0
    return out


def resolve_read_file(db_path, recorded):
    """リード実体の実在パスを返す。

    ★`read_src.path` には**構築時の絶対パス**が入っている。バンドルを別のマシンへ移したり
      コンテナに `/data` としてマウントすると当然そこには無い。DB の隣を探し直す:
        <db のディレクトリ>/reads/<basename>  →  <db のディレクトリ>/<basename>  → 記録された絶対パス
      （バンドル規約では reads/ 直下に置く）
    """
    base = os.path.basename(recorded)
    d = os.path.dirname(os.path.abspath(db_path))
    for cand in (os.path.join(d, "reads", base), os.path.join(d, base), recorded):
        if os.path.exists(cand):
            return cand
    return recorded          # 見つからなければ記録どおり（エラーメッセージに元パスを出したいので）


def read_sources(con):
    """read_src を (sample_no → (path, container, sample_id)) で返す。

    現行は `path` + `container`（'zstd'）。**旧アトラスは `bgzf_path` 列で容器は BGZF** なので、
    列の有無で見分けて両方読めるようにしておく（付け替えずに開ける）。
    """
    cols = {r[1] for r in con.execute("PRAGMA rd.table_info(read_src)")}
    if "path" in cols:
        q = "SELECT sample_no, path, COALESCE(container,'zstd'), sample_id FROM rd.read_src"
    else:
        q = "SELECT sample_no, bgzf_path, 'bgzf', sample_id FROM rd.read_src"
    return {r[0]: (r[1], r[2], r[3]) for r in con.execute(q)}


def open_readers(con, db_path=None):
    src = read_sources(con)
    name = {sn: v[2] for sn, v in src.items()}
    readers = {}

    def get(sn):
        if sn not in readers:
            path, container, _ = src[sn]
            if db_path:
                path = resolve_read_file(db_path, path)
            if container == "bgzf":
                from Bio import bgzf                       # 旧アトラス互換
                h = bgzf.BgzfReader(path, "rb")

                def _bgzf(vo, h=h):
                    h.seek(vo)                             # seek は移動後の位置を返す(捨てる)
                    return h.readline().decode()
                readers[sn] = _bgzf
            else:
                from zstd_seek import SeekableZstdReader
                r = SeekableZstdReader(path, cache=4)      # 直近フレームは持つ＝順に引くと展開1回
                readers[sn] = lambda vo, r=r: r.read_line(vo).decode()
        return readers[sn]
    return get, name


def fetch_line(get_reader, sn, voff):
    return get_reader(sn)(voff)


def fetch_lines(get_reader, rows):
    """[(sample_no, aln_id, voff)] をまとめて取る。

    ★**(サンプル, voff) 順に読む**。zstd は 1 フレーム(既定 256KiB)を展開して行を切り出すので、
      近い位置の行をまとめて引けば展開が 1 回で済む。返す順は入力どおり。
    """
    order = sorted(range(len(rows)), key=lambda i: (rows[i][0], rows[i][2]))
    out = [None] * len(rows)
    for i in order:
        sn, aid, vo = rows[i]
        out[i] = (sn, aid, fetch_line(get_reader, sn, vo))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="base layered DB(read 索引はサイドカー <db>.reads を ATTACH)")
    ap.add_argument("--sidecar", help="read 索引サイドカー DB(既定 <db>.reads)")
    ap.add_argument("--node")
    ap.add_argument("--expand")
    ap.add_argument("--search")
    ap.add_argument("--aln", type=int)
    ap.add_argument("--sample")
    ap.add_argument("--max", type=int, default=100000)
    ap.add_argument("--limit", type=int, default=50)
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    attach_sidecar(con, args.db, args.sidecar)   # read 索引を rd としてくっつける
    get_reader, sample_name = open_readers(con, args.db)
    sample_no = None
    if args.sample:
        r = con.execute("SELECT sample_no FROM rd.read_src WHERE sample_id=?", (args.sample,)).fetchone()
        sample_no = r[0] if r else -1

    if args.node or args.expand:
        name = args.node or args.expand
        # ★葉の名前 `n<数字>` だけを受け付ける。以前は `name[1:]` を無条件に整数化していたので、
        #   クラスタ（`S36286860` 等）を渡すと **まったく別の葉 `n36286860` のリード**を、
        #   要求されたクラスタの名前で返していた（実測で確認）。空を返すより悪い。
        m = re.fullmatch(r'n(\d+)', name)
        if not m:
            print(json.dumps({"reads": {name: []}, "totals": {name: 0},
                              "note": "leaf-only"}))
            return
        gid = int(m.group(1))
        # ★node→reads: node_reads(gfa_id)の posting blob を復号→aln_id 群→read_aln で (sample_no,voff)。
        prow = con.execute("SELECT postings FROM rd.node_reads WHERE gfa_id=?", (gid,)).fetchone()
        aln_ids = _decode_postings(prow[0]) if prow else []
        rows = []
        for i in range(0, len(aln_ids), 900):
            chunk = aln_ids[i:i+900]
            ph = ",".join("?" * len(chunk))
            for sn, aid, vo in con.execute(
                    f"SELECT sample_no, aln_id, voff FROM rd.read_aln WHERE aln_id IN ({ph})", chunk):
                if sample_no is None or sn == sample_no:
                    rows.append((sn, aid, vo))
        rows.sort(key=lambda r: r[1])   # aln_id 順(決定的)
        total = len(rows)
        rows = rows[:args.max]
        lines = fetch_lines(get_reader, rows)
        parsed = [(sn, aid, parse_gaf_line(l)) for sn, aid, l in lines]
        parsed = [(sn, aid, d) for sn, aid, d in parsed if d]
        # サイズは登場する全 path ノード分をまとめて引く
        need = set()
        for _, _, d in parsed:
            for m in TOK.finditer(d["path"]):
                need.add(int(m.group(2)))
        size_of = sizes_for(con, need)
        if args.node:
            reads = []
            for sn, aid, d in parsed:
                for g, strand, off, seg in walk_nodes(d, size_of):
                    if g == gid:
                        rec = node_record(d, g, strand, off, seg)
                        if rec:
                            rec["aln_id"] = aid; rec["sample_id"] = sample_name.get(sn)
                            reads.append(rec)
                        break
            print(json.dumps({"reads": {name: reads}, "totals": {name: total}}))
        else:  # expand: 各リードの全通過ノード
            cohort = {}
            for sn, aid, d in parsed:
                for g, strand, off, seg in walk_nodes(d, size_of):
                    rec = node_record(d, g, strand, off, seg)
                    if not rec:
                        continue
                    rec["aln_id"] = aid; rec["sample_id"] = sample_name.get(sn)
                    cohort.setdefault(f"n{g}", []).append(rec)
            print(json.dumps({"reads": cohort, "totals": {}}))
        return

    if args.aln is not None or args.search:
        if args.aln is not None:
            rows = con.execute("SELECT aln_id,sample_no,voff FROM rd.read_aln WHERE aln_id=?",
                               (args.aln,)).fetchall()
        else:
            q = args.search
            if q.isdigit():
                rows = con.execute("SELECT aln_id,sample_no,voff FROM rd.read_aln WHERE aln_id=?",
                                   (int(q),)).fetchall()
            else:
                rows = con.execute("SELECT aln_id,sample_no,voff FROM rd.read_aln WHERE read_name=? LIMIT ?",
                                   (q, args.limit)).fetchall()
                if not rows and not re.search(r"[*?\[\]]", q):
                    # 前方一致は GLOB。`LIKE 'q%'` は idx_read_aln_name を使えず全走査になる
                    # (SQLite の LIKE 最適化は大小無視 LIKE に NOCASE 照合の索引を要求するが
                    #  read_name は BINARY 照合)。GLOB は大小区別なのでレンジシークになる。
                    rows = con.execute("SELECT aln_id,sample_no,voff FROM rd.read_aln "
                                       "WHERE read_name GLOB ? LIMIT ?", (q + "*", args.limit)).fetchall()
        results = []
        for aid, sn, vo in rows:
            d = parse_gaf_line(fetch_line(get_reader, sn, vo))
            if not d:
                continue
            need = {int(m.group(2)) for m in TOK.finditer(d["path"])}
            size_of = sizes_for(con, need)
            segs = []
            for g, strand, off, seg in walk_nodes(d, size_of):
                rec = node_record(d, g, strand, off, seg)
                if rec:
                    rec["aln_id"] = aid; rec["sample_id"] = sample_name.get(sn)
                    segs.append(rec)
            segs.sort(key=lambda r: r["query_start"])
            results.append({"aln_id": aid, "read_name": d["read_name"],
                            "sample_id": sample_name.get(sn), "segments": segs})
        print(json.dumps({"results": results, "schema": "ondemand"}))
        return

    print(json.dumps({"error": "no query mode"}))


if __name__ == "__main__":
    main()
