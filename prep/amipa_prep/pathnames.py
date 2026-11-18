"""パス名の解釈と参照の選び方（11-17）。前処理の各段（emit・trav・genes・annotate・ann）はここを使う。

パス名の形:
  sample#hap#contig          PanSN（W 行は distill がこの形に直す）
  sample#hap#contig#<整数>   PanSN の 4 項目目（位相ブロック。vg が W 行を P 行に直すと付く `HG00438#2#MT#0`）→ 捨てる
  sample#contig              2 項目（`GRCh38#chrM`）
  sample.chrN                # の無い参照の略記（全ゲノム MC の `GRCh38.chr1`）。. の後が chr で始まるときだけ（`NC_000913.3` を切らない）
  name                       区切りなし（`CASBIT01`）→ sample = contig = name
  末尾の [a-b] / [a:b]       部分範囲 → 捨てる（`CHM13#chrM[0-15992]`）

参照（参照座標・Linear の向きと染色体の順・--band/--gene の写し先）の選び方は 1 つ:
  1. --ref-key が指定され、その sample のパスがある → それ
  2. GFA ヘッダの RS:Z（minigraph-cactus が参照の sample を書く。distill が meta.json の ref_samples に残す）。
     複数並んでいるときはその中で GRCh38 → CHM13 → 先に書かれたもの
  3. GRCh38 → CHM13（大小無視）
  4. 先頭のパスの sample
sample の照合は大小を無視する（PGGB の `grch38` と MC の `GRCh38`）。返す名前は指定・RS:Z・既定の書き方のまま
（段の鍵に入るので、以前の既定 GRCh38 で作った出力一式を作り直さないため）。
"""
import json
import os
import re

_SUBRANGE = re.compile(r"\[\d+[-:]\d+\]$")
DEFAULT_REFS = ("GRCh38", "CHM13")


def split_path(name: str):
    """パス名 → (sample, hap または None, contig)。"""
    base = _SUBRANGE.sub("", name)
    if "#" in base:
        f = base.split("#")
        if len(f) >= 4 and f[-1].isdigit():
            f = f[:-1]
        if len(f) == 2:
            return f[0], None, f[1]
        return f[0], f[1], f[-1]
    if "." in base:
        s, c = base.split(".", 1)
        if c[:3].lower() == "chr":   # GRCh38.chr1 の略記だけ（NC_000913.3 のような版番号を切らない。11-18）
            return s, None, c
    return base, None, base


def sample_of(name: str) -> str:
    return split_path(name)[0]


def contig_of(name: str) -> str:
    return split_path(name)[2]


def acc_seqid(name: str):
    """GFF の対応づけ: (ファイル名の頭 = sample, seqid = contig)。"""
    s, _h, c = split_path(name)
    return s, c


def resolve_ref(names, ref_key=None, rs=()):
    """参照の sample を決める。戻り値 (sample, 理由の文)。パスが無ければ (ref_key or GRCh38, 理由)。"""
    seen = {}
    for n in names:
        s = sample_of(n)
        seen.setdefault(s.lower(), s)
    if not seen:
        return (ref_key or DEFAULT_REFS[0]), "パスが無い（参照座標は作らない）"
    note = ""
    if ref_key:
        if ref_key.lower() in seen:
            return ref_key, f"--ref-key {ref_key}"
        note = f"（--ref-key {ref_key} に当たるパスが無いので規則で選んだ）"
    # RS:Z に複数あるとき（HPRC MC は `RS:Z:CHM13 GRCh38`）は、その中で GRCh38 → CHM13 の順を優先する
    #   （11-18: 先頭の CHM13 を採ると、以前 GRCh38 で作っていた chrY の例の参照と --band（hg38）がずれた）
    rs_ok = [r for r in (rs or ()) if r and r.lower() in seen]
    for d in DEFAULT_REFS:
        for r in rs_ok:
            if r.lower() == d.lower():
                return r, f"GFA ヘッダの RS:Z（{' '.join(rs)}）のうち {r}" + note
    if rs_ok:
        return rs_ok[0], f"GFA ヘッダの RS:Z:{rs_ok[0]}" + note
    for r in DEFAULT_REFS:
        if r.lower() in seen:
            return r, f"既定の参照 {r}" + note
    first = next(iter(seen.values()))
    return first, f"先頭のパスの sample {first}（RS:Z・GRCh38・CHM13 が無い）" + note


def distill_names(distill_dir):
    p = os.path.join(str(distill_dir), "p_names.txt")
    if not os.path.exists(p):
        return []
    with open(p) as fh:
        return [ln for ln in fh.read().splitlines() if ln]


def distill_ref_samples(distill_dir):
    try:
        with open(os.path.join(str(distill_dir), "meta.json")) as fh:
            return json.load(fh).get("ref_samples", [])
    except (OSError, ValueError):
        return []


def resolve_ref_distill(distill_dir, ref_key=None):
    return resolve_ref(distill_names(distill_dir), ref_key, distill_ref_samples(distill_dir))
