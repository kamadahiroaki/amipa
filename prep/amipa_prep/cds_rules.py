"""CDS の扱いの決まり（2026-11-17）。genes_project.py・genelof_build.py が共有し、viewer の trav.ts（travGeneLof）も同じ規則を持つ。

- 転写産物の選び方: 除外（transcript_type が protein_coding_LoF・nonsense_mediated_decay、tag に cds_start_NF・cds_end_NF）を
  外した中から、MANE_Select ＞ Ensembl_canonical ＞ CDS の合計 bp の大きい順。同点は先に出た親（feature の fid の順）。
  全部が除外なら除外を含めて同じ順で選ぶ。
- 判定しない注釈（qc のビット）: 1 pseudo（gene.pseudo か attrs の pseudo=true）、4 partial（partial=true・start_range・end_range・tag の cds_*_NF）。
  元の注釈の遺伝子はどちらも判定しない。写しは、元が pseudo なら判定しない、元が partial なら nostart だけ判定しない（開始が不明。fs・trunc は元と比べられる）
- セレノシステイン: transl_except に Sec、または stop_codon_redefined_as_selenocysteine の行がある転写産物は、TGA を終止として扱わない
- 開始コドン: 既定 ATG・GTG・TTG。transl_table=11 なら原核の代替開始（CTG・ATT・ATC・ATA）も開始とみなす
"""
import re

EXCL_TYPES = ("protein_coding_LoF", "nonsense_mediated_decay")
STARTS = (b"ATG", b"GTG", b"TTG")
STARTS11 = STARTS + (b"CTG", b"ATT", b"ATC", b"ATA")


def kv(attrs, key):
    m = re.search(rf"(?:^|;){key}=([^;]*)", attrs or "")
    return m.group(1) if m else ""


def tx_rank(attrs):
    """(除外か, 優先度 2 MANE_Select / 1 Ensembl_canonical / 0)"""
    tt = kv(attrs, "transcript_type"); tags = kv(attrs, "tag").split(",") if attrs else []
    excl = tt in EXCL_TYPES or "cds_start_NF" in tags or "cds_end_NF" in tags
    pr = 2 if "MANE_Select" in tags else 1 if "Ensembl_canonical" in tags else 0
    return excl, pr


def pick_parent(order, cds_bp, attrs_of):
    """order: 親の出た順のリスト、cds_bp: 親 → CDS の合計 bp、attrs_of: 親 → 最初の CDS 行の attrs。選んだ親を返す"""
    if not order: return None
    rk = {p: tx_rank(attrs_of.get(p, "")) for p in order}
    cand = [p for p in order if not rk[p][0]] or list(order)
    best = None; bk = None
    for p in cand:   # 同点は先に出た親
        k = (rk[p][1], cds_bp.get(p, 0))
        if bk is None or k > bk: best, bk = p, k
    return best


def ann_flags(attrs, gene_pseudo=False):
    """(qc のビット 1 pseudo・4 partial, セレノシステインか, transl_table 11 か)"""
    tags = kv(attrs, "tag").split(",") if attrs else []
    pseudo = bool(gene_pseudo) or kv(attrs, "pseudo") == "true"
    partial = kv(attrs, "partial") == "true" or bool(kv(attrs, "start_range")) or bool(kv(attrs, "end_range")) or "cds_start_NF" in tags or "cds_end_NF" in tags
    skip = (1 if pseudo else 0) | (4 if partial else 0)
    sec = "Sec" in kv(attrs, "transl_except") or "selenocysteine" in tags
    return skip, sec, kv(attrs, "transl_table") == "11"
