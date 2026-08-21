#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# このファイルは prep/ にあるが MIT で提供する。閲覧側（viewer/, MIT）が同じ形式を
# 読むために複製して使うファイルであり、GPL の依存（Infomap）とは無関係なため。
# 詳細は docs/licensing.md を参照。
"""
cs_ops.py — GAF path / cs:Z / CIGAR の共有ヘルパ（numpy 非依存）。

索引を作る側（reads_attach.py）と、閲覧側から呼ばれる照会ヘルパ（reads_query.py）が共有する。
照会ヘルパはこの module だけ import すれば numpy を読まずに済み、1 リクエスト 1 プロセスでも起動が速い。
**cs の切り出しはここ 1 箇所**にまとめてある（前処理と閲覧で解釈がずれないように）。
"""
import re, zlib

# ── BLOB 圧縮（cigar / cs 共通）─────────────────────────────────────────────
def compress_blob(s):
    """文字列を BLOB 化。zlib 圧縮し縮まなければ生バイト。読み出し側は先頭バイトで判別
    （zlib=0x78、CIGAR=数字 0x30-39、cs= ':' '*' '+' '-' のいずれも 0x78 でない）。"""
    if s is None:
        return None
    b = s.encode()
    c = zlib.compress(b, 6)
    return c if len(c) < len(b) else b


# ── GAF path 展開 ─────────────────────────────────────────────────────────
def parse_path(path_str):
    """'>123<456' → [(token, strand)]。token は整数ノード id（giraffe/PGGB は整数 seg id）。"""
    out = []
    for m in re.finditer(r'([><])([^><]+)', path_str):
        out.append((m.group(2), '+' if m.group(1) == '>' else '-'))
    return out


# ── cs:Z 対応（dbbuilder/compute_graph_coverage.py より移植）────────────────
COMP = str.maketrans('acgtnACGTN', 'tgcanTGCAN')
def _comp(s): return s.translate(COMP)
def _rc(s):   return s.translate(COMP)[::-1]
CS_TOK = re.compile(r':\d+|\*[a-zA-Z]{2}|[+-][a-zA-Z]+')


def extract_node_cs(cs, path_start, a0, a1, strand):
    """フルパス cs をノードの ref 範囲 [a0,a1)（パス座標）へ切り出す。'-' 鎖はノード正方向へ反転＋相補。"""
    if not cs:
        return None
    ops = []
    pos = path_start
    for m in CS_TOK.finditer(cs):
        t = m.group(0); c0 = t[0]
        if c0 == ':':
            L = int(t[1:]); s = max(pos, a0); e = min(pos + L, a1)
            if s < e: ops.append((':', e - s))
            pos += L
        elif c0 == '*':
            if a0 <= pos < a1: ops.append(('*', t[1], t[2]))
            pos += 1
        elif c0 == '-':
            seq = t[1:]; L = len(seq); s = max(pos, a0); e = min(pos + L, a1)
            if s < e: ops.append(('-', seq[s - pos:e - pos]))
            pos += L
        else:  # '+': 挿入は ref を消費しない
            if a0 <= pos < a1: ops.append(('+', t[1:]))
    if not ops:
        return None
    if strand == '-':
        ops = ops[::-1]
        ops = [o if o[0] == ':'
               else ('*', _comp(o[1]), _comp(o[2])) if o[0] == '*'
               else (o[0], _rc(o[1])) for o in ops]
    return ''.join(':%d' % o[1] if o[0] == ':'
                   else '*%s%s' % (o[1], o[2]) if o[0] == '*'
                   else '%s%s' % (o[0], o[1]) for o in ops)


def cs_to_cigar(node_cs):
    """ノード正方向 cs を CIGAR(=/X/I/D) へ（同種 op を連結）。"""
    if not node_cs:
        return None
    ops = []
    for m in CS_TOK.finditer(node_cs):
        t = m.group(0); c0 = t[0]
        if   c0 == ':': L, op = int(t[1:]), '='
        elif c0 == '*': L, op = 1, 'X'
        elif c0 == '+': L, op = len(t) - 1, 'I'
        else:           L, op = len(t) - 1, 'D'
        if ops and ops[-1][1] == op:
            ops[-1][0] += L
        else:
            ops.append([L, op])
    return ''.join(f'{l}{o}' for l, o in ops) if ops else None


def cs_has_diff(node_cs):
    return node_cs is not None and ('*' in node_cs or '+' in node_cs or '-' in node_cs)


def extract_node_cigar(full_cigar, path_start, node_aln_start, node_aln_end, strand):
    """cg:Z（塩基なし CIGAR）からノード範囲を切り出す（cs:Z が無いアライメント用フォールバック）。"""
    if not full_cigar:
        return None
    node_ops = []
    path_pos = path_start
    for m in re.finditer(r'(\d+)([MIDNSHPX=])', full_cigar):
        length = int(m.group(1)); op = m.group(2)
        if op in '=XMD':
            cl_s = max(path_pos, node_aln_start)
            cl_e = min(path_pos + length, node_aln_end)
            if cl_s < cl_e:
                node_ops.append((op, cl_e - cl_s))
            path_pos += length
        elif op == 'I':
            if node_aln_start <= path_pos < node_aln_end:
                node_ops.append(('I', length))
        elif op in 'SH':
            pass
        elif op in 'NP':
            path_pos += length
    if not node_ops:
        return None
    if strand == '-':
        node_ops = list(reversed(node_ops))
    return ''.join(f'{l}{o}' for o, l in node_ops)
