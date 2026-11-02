#!/usr/bin/env python3
"""遺伝子サイドカー <db>.genes を作る（株ごとの GFF をパスのトークン範囲に写す）。plans/msa-annotation.md §5、decisions/0006。
  python3 genes_build.py --distill <db>.distill --gff-dir <GFF の置き場> --out <db>.genes [--synteny <db>.synteny]
  GFF はパス名の先頭（# の前。GRCh38#chr20 → GRCh38、GCF_000148365.1#1#NC_017631.1 → GCF_000148365.1）を名前にした <gff-dir>/<名前>.gff。
  seqid はパス名の最後の # の後（部分範囲 [a-b] は落とす）。
  ★11-02 に functions/msa_lod/annot/build_genes.py から prep へ移した。古い木（.synteny）は任意: あれば原子（gene_atom）と接合×遺伝子（junc_gene。古い Blocks パネルの接合カード用）も作る。
    Traversals は gene・gene_tok・feature・feature_tok・gff_header だけを使う
表:
  gene(gid, pid, start, end, strand, type, name, locus, product, pseudo, fid) … コンティグ bp（1-based、両端含む）。CDS は gene ごとに併合。
                                                                              fid = この行の元になった GFF の行（feature.fid）
  gene_tok(gid, s0, e0, so, eo)                                            … その株のパスのトークン範囲 [s0, e0)（distill p_tok の添字）と、開始塩基のトークン s0 の
                                                                              ノード内オフセット so・終了塩基のトークン e0-1 のノード内オフセット eo（★ノードの格納向きで 0-based。
                                                                              逆向きに通るトークンは len-1-o に直してある。backend はこれで塩基の列を特定する。inst.pos は
                                                                              s0 の bp と 2〜82 bp ずれているので cum の起点に使えない＝2026-10-16 に判明）
  gene_atom(gid, a0, a1)                                                   … 重なる原子（インスタンス）の範囲
  junc_gene(jid, pid, gid, cls, left, right, mid, dist)                    … 接合 × 遺伝子。cls: split / isl（abs での分断＝他株で島が遺伝子内）/
                                                                              end（片端が接合区間内）/ inside（丸ごと接合区間内）/ near（距離 ≤ NEAR）
  ★入力 GFF を欠けなく再現するための表（2026-10-16、format 2）:
  feature(fid, pid, acc, seqid, source, type, start, end, score, strand, phase, attrs, id, parent, gid, lineno)
      … GFF の全データ行を 9 列そのまま（attrs は第 9 列の原文。score/phase は '.' も文字列のまま）。id = ID 属性、parent = 最初の Parent の fid、
        gid = 属する gene 行（自分か祖先が gene 行なら）。pid = seqid がグラフのパスなら、そのパス。lineno = ファイルの行番号（1-based）
  feature_tok(fid, s0, e0, so, eo)                                         … feature のトークン範囲とノード内オフセット（gene_tok と同じ）（pid のあるものだけ）
  gff_header(acc, lineno, line)                                            … '#' で始まる行（##gff-version、##sequence-region など）そのまま
  → 1 株の GFF は gff_header ∪ feature を lineno 順に並べれば元のとおりに戻る（backend GET /api/blocks/gff）。
閾値: 分断・片端は 1 bp（2026-10-08 決定）。near は距離を持ち既定 1,000 bp。"""
import sys, os, sqlite3, glob, collections, time, argparse
import numpy as np
ap = argparse.ArgumentParser(); ap.add_argument("--distill", required=True); ap.add_argument("--gff-dir", required=True); ap.add_argument("--out", required=True)
ap.add_argument("--synteny", default="", help="古い木 <db>.synteny（任意）。あれば gene_atom と junc_gene も作る")
A = ap.parse_args(); G = A.gff_dir; NEAR = 1000
t0 = time.time()
syn = sqlite3.connect(f"file:{A.synteny}?mode=ro", uri=True) if A.synteny else None
dist = A.distill; p_off = np.load(f"{dist}/p_off.npy"); p_tok = np.load(f"{dist}/p_tok.npy", mmap_mode="r")
p_names = open(f"{dist}/p_names.txt").read().splitlines(); pidx = {nm: i for i, nm in enumerate(p_names)}
_sid = np.load(f"{dist}/s_id.npy"); _sbp = np.load(f"{dist}/s_bp.npy"); s_bp = np.zeros(len(_sid), np.int64); s_bp[_sid - 1] = _sbp   # ★ s_bp.npy は S 行のファイル順。s_id（dense id）で並べ直してから s_bp[tok-1]（2026-10-22: ヒトでここが違い、遺伝子のトークン範囲が全部ずれていた）
p_ori = np.load(f"{dist}/p_ori.npy", mmap_mode="r")   # トークンの向き（1=格納向き）
# パスの一覧: pid は distill の順（.trav・.synteny の pid と同じ。ecoli50・chr202122v2 で全数一致を確認）。長さ L は古い木があればその値（検算用）
paths = {pid: (path, int(bp)) for pid, path, bp in syn.execute("SELECT pid, path, bp FROM paths")} if syn else {i: (nm, None) for i, nm in enumerate(p_names)}
out = A.out; tmp = out + ".tmp"
if os.path.exists(tmp): os.remove(tmp)
con = sqlite3.connect(tmp); cur = con.cursor()
cur.executescript("""
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE gene(gid INTEGER PRIMARY KEY, pid INTEGER, start INTEGER, end INTEGER, strand TEXT, type TEXT, name TEXT, locus TEXT, product TEXT, pseudo INTEGER, fid INTEGER);
CREATE TABLE gene_tok(gid INTEGER PRIMARY KEY, s0 INTEGER, e0 INTEGER, so INTEGER, eo INTEGER);
CREATE TABLE gene_atom(gid INTEGER PRIMARY KEY, a0 INTEGER, a1 INTEGER);
CREATE TABLE junc_gene(jid INTEGER, pid INTEGER, gid INTEGER, cls TEXT, left INTEGER, right INTEGER, mid INTEGER, dist INTEGER);
CREATE TABLE feature(fid INTEGER PRIMARY KEY, pid INTEGER, acc TEXT, seqid TEXT, source TEXT, type TEXT, start INTEGER, end INTEGER, score TEXT, strand TEXT, phase TEXT, attrs TEXT, id TEXT, parent INTEGER, gid INTEGER, lineno INTEGER);
CREATE TABLE feature_tok(fid INTEGER PRIMARY KEY, s0 INTEGER, e0 INTEGER, so INTEGER, eo INTEGER);
CREATE TABLE gff_header(acc TEXT, lineno INTEGER, line TEXT);
""")
# ---- GFF: 全行を読む。データ行は 9 列そのまま＋属性の辞書、'#' の行は gff_header へ ----
class Rec:
    __slots__ = ("fid", "lineno", "seqid", "source", "type", "start", "end", "score", "strand", "phase", "attrs", "a", "parent", "gid")
fid_next = 0; acc_recs = {}                       # acc → (recs, feats_by_seqid)
def load_gff(acc):
    global fid_next
    if acc in acc_recs: return acc_recs[acc]
    f = f"{G}/{acc}.gff"; recs = []; feats = collections.defaultdict(list); hdr = []
    if os.path.exists(f):
        for ln, line in enumerate(open(f), 1):
            line = line.rstrip("\n")
            if not line.strip(): continue
            if line.startswith("#"): hdr.append((acc, ln, line)); continue
            p = line.split("\t")
            if len(p) < 9: hdr.append((acc, ln, line)); continue   # 9 列に満たない行も捨てずに header 側へ（再現のため）
            r = Rec(); fid_next += 1; r.fid = fid_next; r.lineno = ln
            r.seqid, r.source, r.type, r.start, r.end, r.score, r.strand, r.phase, r.attrs = p[0], p[1], p[2], int(p[3]), int(p[4]), p[5], p[6], p[7], "\t".join(p[8:])
            r.a = dict(kv.split("=", 1) for kv in r.attrs.split(";") if "=" in kv); r.parent = None; r.gid = None
            recs.append(r); feats[r.seqid].append(r)
        id2 = {r.a["ID"]: r for r in recs if "ID" in r.a}
        for r in recs:
            pa = r.a.get("Parent"); q = id2.get(pa.split(",")[0]) if pa else None
            r.parent = q.fid if q else None
    cur.executemany("INSERT INTO gff_header VALUES (?,?,?)", hdr)
    acc_recs[acc] = (recs, feats); return acc_recs[acc]
KEEP = {"gene", "pseudogene", "rRNA", "tRNA", "ncRNA", "tmRNA", "SRP_RNA", "RNase_P_RNA", "antisense_RNA", "riboswitch", "mobile_element", "repeat_region", "regulatory_region"}
gid = 0; genes_by_pid = {}; n_cds = 0; fid2gid = {}; seq2pid = {}
for pid, (path, L) in paths.items():
    if "#" in path: acc = path.split("#")[0]; seqid = path.split("#")[-1].split("[")[0]   # 最後の # 区切りが seqid（`GRCh38#chr20` は 2 項、`GCF#1#NZ_…` は 3 項）。部分範囲 [a-b] は落とす
    else: acc, _, seqid = path.partition("."); seqid = (seqid or path).split("[")[0]   # # の無い名前（全ゲノム MC の `GRCh38.chr1`）は最初の . で sample と seqid に分ける（11-02）
    seq2pid[(acc, seqid)] = pid
    feats = load_gff(acc)[1].get(seqid, [])
    cds = collections.defaultdict(list); rows = []
    byid = {r.a["ID"]: r for r in feats if "ID" in r.a}
    def gene_of(r):
        """CDS の属する gene/pseudogene の ID（RefSeq: Parent が gene。GENCODE: Parent が転写産物 → その Parent が gene）"""
        q = r
        for _ in range(4):
            pa = q.a.get("Parent"); q = byid.get(pa.split(",")[0]) if pa else None
            if q is None: return r.a.get("Parent", "")
            if q.type in ("gene", "pseudogene"): return q.a.get("ID", "")
        return r.a.get("Parent", "")
    for r in feats:
        if r.type == "CDS": cds[gene_of(r)].append((r.start, r.end, r.a.get("product", ""), r.a.get("pseudo") == "true"))
    for r in feats:
        t = r.type; a = r.a; s, e, st_ = r.start, r.end, r.strand
        if t not in KEEP: continue
        if t == "gene":
            bt = a.get("gene_biotype", "") or a.get("gene_type", ""); cl = cds.get(a.get("ID", ""), [])
            if "pseudogene" in bt.lower() and a.get("pseudo") != "true": a = dict(a, pseudo="true")   # GENCODE: 擬似は gene_type で分かる
            if cl: s, e = min(c[0] for c in cl), max(c[1] for c in cl)
            typ = "cds" if cl else (bt or "gene")
            if cl and not a.get("product"): a = dict(a, product=next((c[2] for c in cl if c[2]), ""))   # 産物は CDS 側に付く（RefSeq GFF）
            if cl and any(c[3] for c in cl): a = dict(a, pseudo="true")
        else: typ = t
        rows.append((pid, s, e, st_, typ, a.get("Name") or a.get("gene_name") or a.get("gene") or a.get("locus_tag") or a.get("ID", ""), a.get("locus_tag", "") or a.get("gene_id", ""), a.get("product", "") or a.get("description", ""), 1 if (t == "pseudogene" or a.get("pseudo") == "true") else 0, r.fid))
    rows.sort(key=lambda r: (r[1], r[2]))
    lst = []
    for r in rows:
        gid += 1; lst.append((gid,) + r); n_cds += (r[4] == "cds"); fid2gid[r[9]] = gid
    genes_by_pid[pid] = lst
    cur.executemany("INSERT INTO gene VALUES (?,?,?,?,?,?,?,?,?,?,?)", lst)
print(f"gene: {gid:,} 行（cds {n_cds:,}）, {time.time()-t0:.1f}s", file=sys.stderr)
# ---- feature: 全データ行。gid は自分か祖先の gene 行 ----
n_feat = 0; feat_by_pid = collections.defaultdict(list)
for acc, (recs, feats) in acc_recs.items():
    byfid = {r.fid: r for r in recs}
    for r in recs:
        q = r; g = None; hops = 0
        while q is not None and hops < 8:
            g = fid2gid.get(q.fid)
            if g is not None: break
            q = byfid.get(q.parent) if q.parent is not None else None; hops += 1
        r.gid = g
    rows_f = []
    for r in recs:
        pid = seq2pid.get((acc, r.seqid))
        rows_f.append((r.fid, pid, acc, r.seqid, r.source, r.type, r.start, r.end, r.score, r.strand, r.phase, r.attrs, r.a.get("ID"), r.parent, r.gid, r.lineno))
        if pid is not None: feat_by_pid[pid].append((r.fid, r.start, r.end))
    cur.executemany("INSERT INTO feature VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows_f); n_feat += len(rows_f)
print(f"feature: {n_feat:,} 行（{len(acc_recs)} ファイル）, {time.time()-t0:.1f}s", file=sys.stderr)
# ---- トークン範囲と原子（gene と feature の両方） ----
inst = collections.defaultdict(list)
if syn:
    for pid, atom, s0, e0 in syn.execute("SELECT pid, atom, s0, e0 FROM inst"): inst[pid].append((s0, e0, atom))
rows_tok = []; rows_atom = []; rows_ftok = []; n_badlen = 0
def tok_range(cum, n_, s, e, toks=None, ori=None):
    """コンティグ bp [s, e)（0-based 半開）→ トークン範囲 [k0, k1) と、開始塩基の k0 内オフセット・終了塩基の k1-1 内オフセット（ノードの格納向き）"""
    k0 = int(np.searchsorted(cum, s, side="right") - 1); k1 = int(np.searchsorted(cum, e, side="left"))
    k0 = max(0, min(k0, n_ - 1)); k1 = max(k0 + 1, min(k1, n_))
    so = int(s - cum[k0]); eo = int((e - 1) - cum[k1 - 1])
    if toks is not None:
        L0 = int(s_bp[toks[k0] - 1]); L1 = int(s_bp[toks[k1 - 1] - 1]); so = max(0, min(L0 - 1, so)); eo = max(0, min(L1 - 1, eo))
        if not ori[k0]: so = L0 - 1 - so
        if not ori[k1 - 1]: eo = L1 - 1 - eo
    return k0, k1, so, eo
for pid, (path, L) in paths.items():
    i = pidx.get(path); lst = genes_by_pid.get(pid, []); fl = feat_by_pid.get(pid, [])
    if i is None or not (lst or fl): continue
    off = int(p_off[i]); n_ = int(p_off[i + 1] - p_off[i]) if i + 1 < len(p_off) else int(len(p_tok) - off)
    toks = np.asarray(p_tok[off:off + n_], dtype=np.int64); bp = s_bp[toks - 1]; ori = np.asarray(p_ori[off:off + n_])
    cum = np.concatenate(([0], np.cumsum(bp)))                      # cum[k] = トークン k の 0-based 開始（ノード長は distill の s_bp。列の無いトークンも数える）
    if L is not None and int(cum[-1]) != L: n_badlen += 1
    its = sorted(inst[pid]); its_s = np.array([x[0] for x in its]); its_e = np.array([x[1] for x in its]); its_a = np.array([x[2] for x in its])
    for g in lst:
        k0, k1, so, eo = tok_range(cum, n_, g[2] - 1, g[3], toks, ori)
        rows_tok.append((g[0], k0, k1, so, eo))
        sel = np.flatnonzero((its_s < k1) & (its_e > k0))
        if sel.size: rows_atom.append((g[0], int(its_a[sel].min()), int(its_a[sel].max())))
    for fid, s, e in fl:
        k0, k1, so, eo = tok_range(cum, n_, s - 1, e, toks, ori); rows_ftok.append((fid, k0, k1, so, eo))
cur.executemany("INSERT INTO gene_tok VALUES (?,?,?,?,?)", rows_tok); cur.executemany("INSERT INTO gene_atom VALUES (?,?,?)", rows_atom)
cur.executemany("INSERT INTO feature_tok VALUES (?,?,?,?,?)", rows_ftok)
print(f"gene_tok {len(rows_tok):,}, gene_atom {len(rows_atom):,}, feature_tok {len(rows_ftok):,}, 長さの検算 NG {n_badlen} パス, {time.time()-t0:.1f}s", file=sys.stderr)
# ---- 接合 × 遺伝子 ----
rows_jg = []; cnt = collections.Counter()
for pid, (path, L) in (paths.items() if syn else []):
    lst = genes_by_pid.get(pid, [])
    if not lst: continue
    starts = np.array([g[2] for g in lst]); ends = np.array([g[3] for g in lst])
    for jid, a2, b2, wrap, typ in syn.execute("SELECT rowid, a2, b2, wrap, type FROM junc WHERE pid=?", (pid,)):
        for off in ((0, L) if wrap else (0,)):
            lo, hi = a2 - NEAR, b2 + NEAR
            cand = np.flatnonzero((ends + off >= lo) & (starts + off <= hi))
            for k in cand:
                g = lst[k]; ss, ee = g[2] + off, g[3] + off
                left = max(0, min(ee, a2) - ss + 1); right = max(0, ee - max(ss, b2 + 1) + 1); mid = max(0, min(ee, b2) - max(ss, a2 + 1) + 1)
                if left >= 1 and right >= 1: cls = "isl" if typ == "abs" else "split"; dist = 0
                elif (left >= 1) != (right >= 1) and mid >= 1: cls = "end"; dist = 0
                elif mid >= 1: cls = "inside"; dist = 0
                else:
                    dist = (a2 + 1 - ee) if ee <= a2 else (ss - b2); cls = "near"
                    if dist > NEAR: continue
                rows_jg.append((jid, pid, g[0], cls, left, right, mid, dist)); cnt[(typ, cls)] += 1
cur.executemany("INSERT INTO junc_gene VALUES (?,?,?,?,?,?,?,?)", rows_jg)
cur.executescript("CREATE INDEX idx_gene_pid ON gene(pid, start); CREATE INDEX idx_jg_pid ON junc_gene(pid, jid); CREATE INDEX idx_jg_gid ON junc_gene(gid); CREATE INDEX idx_jg_jid ON junc_gene(jid);"
                  "CREATE INDEX idx_feat_pid ON feature(pid, start); CREATE INDEX idx_feat_gid ON feature(gid); CREATE INDEX idx_feat_parent ON feature(parent); CREATE INDEX idx_feat_acc ON feature(acc, lineno); CREATE INDEX idx_hdr_acc ON gff_header(acc, lineno);")   # jid: 接合カード・接合一覧・genes の接
for k, v in [("format", 3), ("near_bp", NEAR), ("split_bp", 1), ("n_gene", gid), ("n_cds", n_cds), ("n_feature", n_feat), ("n_junc_gene", len(rows_jg)), ("gff_dir", os.path.abspath(G)), ("built", time.strftime("%Y-%m-%d %H:%M"))]: cur.execute("INSERT INTO meta VALUES (?,?)", (k, str(v)))
con.commit(); con.close(); os.replace(tmp, out)
print(f"junc_gene {len(rows_jg):,}: " + ", ".join(f"{t}/{c} {n}" for (t, c), n in sorted(cnt.items())), file=sys.stderr)
print(f"→ {out} ({os.path.getsize(out)/1e6:.1f} MB), {time.time()-t0:.1f}s", file=sys.stderr)
