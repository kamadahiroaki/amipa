#!/usr/bin/env python3
"""自明バブルの連鎖を 1 ノードに畳む（可逆）。

`A>(B|C)>D>(E|F)>G` のような連鎖を 1 ノードにし、アレルの差分はグラフの外に出す。
出力は 3 つ:

  <out>            畳み込み GFA（代表配列）
  <out>.wildcard   変異位置に IUPAC 縮重塩基を置いた GFA（マッピング入力用）
  <out>.collapse   対応付けサイドカー（SQLite）

畳める条件:
  1. アレルが全部同じ長さ（位置ごとに IUPAC 1 文字で表せる）。
     側面同士を直接つなぐ辺（長さ 0 のアレル＝欠失）を持つバブルも除く
  2. そのバブルの側面を通る区間は、全てそのバブルの中（アレル）を通る。かつ反復でない
  3. 単独ノードは畳まない（自己再訪を 1 ステップにまとめない）

★向きの規約: GFA のステップ (node, ori) が寄与するのは ori='+' なら seq(node)、
  '-' なら revcomp(seq(node))。代表配列 S_g は「代表区間の各ステップの向きを適用してから
  通過順に連結」したもの。生連結でも一括逆相補でもない。

★可逆性: 条件 2 により区間内のステップは S_g を隙間なく・重なりなく敷き詰めるので、
  「S_g に各ステップの塩基を貼る → 区間が '-' なら全体を逆相補」で元の配列と定義上一致する。
  置換は「パス×バブル」ではなく **区間の通過ごと・位置ごと** に持つ
  （同一パスが同じバブルを何度も通るグラフでは前者は成立しない）。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

COMP = np.arange(256, dtype=np.uint8)
for _a, _b in zip(b"ACGTacgtNn", b"TGCAtgcaNn"):
    COMP[_a] = _b
BIT = np.full(256, 15, np.uint8)
for _c, _v in zip(b"ACGTacgt", [1, 2, 4, 8, 1, 2, 4, 8]):
    BIT[_c] = _v
IUPAC = np.frombuffer(b"NACMGRSVTWYHKDBN", np.uint8)
POPC = np.array([bin(i).count("1") for i in range(16)], np.uint8)
SIGN = [b"-", b"+"]

SCHEMA2 = """
PRAGMA journal_mode=OFF;
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
-- 元ノード -> 畳み込みノード。元の名前で検索して塩基位置へ飛ぶために使う
CREATE TABLE orig_node(
  orig_id INTEGER PRIMARY KEY,   -- 元 GFA のノード名（数値）
  gid     INTEGER NOT NULL,      -- 畳み込みノード（GFA の名前と同じ 1-based）
  off     INTEGER NOT NULL,      -- 代表配列内のオフセット (bp)
  len     INTEGER NOT NULL,
  ori     INTEGER NOT NULL       -- 1 = 代表と同じ向き / 0 = 逆
);
CREATE INDEX idx_orig_gid ON orig_node(gid);
-- 畳み込みノード内の MSA。変異する列だけを持つ（非変異列は代表配列そのもの）。
-- ★これは表示用であると同時に、元の配列を完全に復元できる表でもある。
CREATE TABLE node_msa(
  gid   INTEGER PRIMARY KEY,
  nrun  INTEGER NOT NULL,        -- このノードを通る区間の数（= MSA の行数）
  ncol  INTEGER NOT NULL,        -- スロット数
  cols  BLOB,                    -- int32[ncol]  GFA ノード内のスロット開始位置
  colw  BLOB,                    -- int32[ncol]  GFA ノード内のスロット幅
  slotw BLOB,                    -- int32[ncol]  セルでのスロット幅（最長アレル）
  cells BLOB,                    -- uint8[nrun*Σslotw]  行優先。短いアレルは '-' 詰め
  paths BLOB                     -- int32[nrun]  各行がどのパスか
);
-- パスがどの畳み込みノードをどの向きで辿るか（GFA の P 行と同じ順）
CREATE TABLE path_runs(
  path INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  n    INTEGER NOT NULL,
  gids BLOB,                     -- int32[n]
  oris BLOB,                     -- uint8[n]   1 = 代表と同じ向き
  rows BLOB                      -- int32[n]   node_msa 内の行番号
);
"""


def _log(t0, msg):
    print(f"[collapse {time.time() - t0:7.1f}s] {msg}", flush=True)


try:
    from numba import njit
except Exception:                                    # numba が無い環境でも動くように
    def njit(*a, **k):
        def deco(f): return f
        return deco if not (a and callable(a[0])) else a[0]


@njit(cache=True)
def _split_at_revisit(rows, chg, lastseen):
    """★段3: 同じ区間の中で同じノードを 2 度通らないように、再訪の位置で区間を切る。

    縦列反復では、こうすると 1 周が 1 区間になる。コピー数は「その区間が何本あるか」に
    なるので、ハプロタイプごとのコピー数の違いが自然に表現される。
    （chg には既に「グループの変化・単独ノード・パスの先頭」の印が立っている）
    """
    start = 0
    for i in range(rows.size):
        if chg[i]:
            start = i
        v = rows[i]
        if lastseen[v] >= start:
            chg[i] = True
            start = i
        lastseen[v] = i


def _step_bases_arr(seqa, seq_off, s_bp, COMP, v, ori):
    """ステップ列 (v, ori) が寄与する塩基を平坦に返す（ori=0 は逆相補）"""
    lens = s_bp[v]
    seg, within, off = _ragged(lens)
    base = np.where(ori, seq_off[v], seq_off[v + 1] - 1)
    stp = np.where(ori, 1, -1)
    val = seqa[base[seg] + stp[seg] * within]
    return np.where(ori[seg].astype(bool), val, COMP[val]), off


def _ragged(lens):
    """長さ lens の可変長セグメントを平坦化する (seg, within, off)"""
    off = np.zeros(lens.size + 1, np.int64)
    np.cumsum(lens, out=off[1:])
    seg = np.repeat(np.arange(lens.size), lens)
    return seg, np.arange(off[-1]) - off[seg], off


def collapse(distill: Path, out_gfa: Path, wildcard: bool = True,
             sidecar: Path | None = None, msa_cap: int = 4_000_000,
             rep_mode: str = "consensus", ref_key: str | None = None,
             indel_max: int = 0, split_repeats: bool = True):
    t0 = time.time()
    d = lambda n: np.load(str(distill / n))

    s_id = d("s_id.npy").astype(np.int64)
    s_bp = d("s_bp.npy").astype(np.int64)
    la, lb = d("l_a.npy"), d("l_b.npy")
    p_tok, p_ori = d("p_tok.npy"), d("p_ori.npy").astype(np.int8)
    p_off = d("p_off.npy").astype(np.int64)
    seq_off = d("s_seq_off.npy").astype(np.int64)
    seqa = np.array(np.memmap(str(distill / "s_seq.bin"), dtype=np.uint8, mode="r"))
    names = [l.rstrip("\n") for l in open(distill / "p_names.txt")]

    ref_paths = set()
    if rep_mode == "ref":
        if not ref_key:
            raise SystemExit("--rep ref には --ref-key が要る")
        ref_paths = {i for i, nm in enumerate(names)
                     if nm == ref_key or nm.split("#", 1)[0] == ref_key}
        if not ref_paths:
            raise SystemExit(f"--ref-key {ref_key} に一致するパスが無い")

    n = s_id.size
    id2row = np.empty(int(s_id.max()) + 1, np.int64)
    id2row[s_id] = np.arange(n)
    ei, ej, rows = id2row[la], id2row[lb], id2row[p_tok]
    T, P = rows.size, p_off.size - 1
    if s_bp.min() < 1:
        raise SystemExit("0 bp のノードがある。畳み込みは扱えない")
    _log(t0, f"ノード {n:,} / 辺 {ei.size:,} / パス {P} / ステップ {T:,}")

    def step_bases(v, ori):
        """ステップ列 (v, ori) が寄与する塩基を平坦に返す（ori=0 は逆相補）"""
        lens = s_bp[v]
        seg, within, off = _ragged(lens)
        base = np.where(ori, seq_off[v], seq_off[v + 1] - 1)
        stp = np.where(ori, 1, -1)
        val = seqa[base[seg] + stp[seg] * within]
        return np.where(ori[seg].astype(bool), val, COMP[val]), off

    # ── 1. 自明バブル ────────────────────────────────────────────
    src = np.concatenate([ei, ej])
    dst = np.concatenate([ej, ei])
    o_ = np.argsort(src, kind="stable")
    src, dst = src[o_], dst[o_]
    ip = np.zeros(n + 1, np.int64)
    np.add.at(ip[1:], src, 1)
    np.cumsum(ip, out=ip)
    deg = np.diff(ip)

    cand = np.flatnonzero(deg == 2)
    nb0, nb1 = dst[ip[cand]], dst[ip[cand] + 1]
    u_, w_ = np.minimum(nb0, nb1), np.maximum(nb0, nb1)
    ok = u_ != w_
    cand, u_, w_ = cand[ok], u_[ok], w_[ok]
    key = u_ * np.int64(n) + w_
    o2 = np.argsort(key, kind="stable")
    ks, al, au, aw = key[o2], cand[o2], u_[o2], w_[o2]
    ng = np.r_[True, ks[1:] != ks[:-1]]
    gs = np.flatnonzero(ng)
    sz = np.diff(np.append(gs, ks.size))
    bub = np.flatnonzero(sz >= 2)
    _log(t0, f"自明バブル {bub.size:,} / アレルノード {int(sz[bub].sum()):,}")

    # 条件 1: 同長 かつ 側面同士の直接辺（長さ 0 のアレル）が無い
    ekey = np.unique(np.minimum(ei, ej) * np.int64(n) + np.maximum(ei, ej))
    bypass = np.isin(au[gs[bub]] * np.int64(n) + aw[gs[bub]], ekey)
    # ★v2: アレルの同長は要求しないが、**長さの差に上限を置く**。
    #   大きな indel は「見たい構造多型」そのものなので、ノードの中に隠さずグラフに残す
    #   （PanGraph が L_min 未満の構造変異だけを pancontig 内部に入れるのと同じ考え方）。
    #   空アレル（側面同士の直接辺）は鎖の要素数が合わなくなるので当面除外する。
    dlen = np.array([int(s_bp[al[gs[g]:gs[g]+sz[g]]].max() - s_bp[al[gs[g]:gs[g]+sz[g]]].min())
                     for g in bub], np.int64)
    small = dlen <= indel_max
    _log(t0, f"  条件1: 長さの差 0(SNP 等) {int((dlen == 0).sum()):,} / "
             f"1..{indel_max} bp の indel {int(((dlen > 0) & small).sum()):,}（畳む）/ "
             f">{indel_max} bp の indel {int((~small).sum()):,}（★グラフに残す）/ "
             f"空アレル {int(bypass.sum()):,}（除外）")
    bidx = bub[small & ~bypass]

    def build(bidx_):
        bu_, bw_ = au[gs[bidx_]], aw[gs[bidx_]]
        A = coo_matrix((np.ones(bu_.size, np.int8), (bu_, bw_)), shape=(n, n))
        _, lab = connected_components(A, directed=False)
        an = np.zeros(n, bool)
        an[bu_] = True
        an[bw_] = True
        gid = np.full(n, -1, np.int64)
        gid[an] = lab[an]
        for g in bidx_:
            gid[al[gs[g]:gs[g] + sz[g]]] = lab[au[gs[g]]]
        used = np.unique(gid[gid >= 0])
        rm = np.full(int(used.max()) + 1, -1, np.int64)
        rm[used] = np.arange(used.size)
        G0 = used.size
        grp_ = np.empty(n, np.int64)
        m = gid >= 0
        grp_[m] = rm[gid[m]]
        grp_[~m] = G0 + np.arange(int((~m).sum()))
        return grp_, G0 + int((~m).sum()), G0

    def runs_of(grp_, G_):
        solo = np.bincount(grp_, minlength=G_) == 1          # 条件 3
        g_ = grp_[rows]
        chg = np.empty(T, bool)
        chg[0] = True
        np.not_equal(g_[1:], g_[:-1], out=chg[1:])
        np.logical_or(chg[1:], solo[g_[1:]], out=chg[1:])
        chg[p_off[:-1]] = True                               # パスの先頭は必ず切る
        if split_repeats:
            lastseen = np.full(n, -1, np.int64)
            _split_at_revisit(rows, chg, lastseen)
        st = np.flatnonzero(chg)
        return st, np.append(st[1:], T), np.searchsorted(p_off, st, side="right") - 1

    # ── 2. 条件 2（v2）: 長さの一致は要求しない。構造条件だけを全バブルに直接適用する ──
    #   「そのバブルの側面を通る区間は、全てそのバブルの中（アレル）を通る」。
    #   これが成り立てば、どの区間も鎖の全ての側面と全てのスロットを 1 回ずつ通るので、
    #   bp を数えずに**添字**でスロットとアレルを対応させられる（長さが違ってもずれない）。
    #   反復（1 本の区間が同じ側面を 2 回以上通る）は当面除外する（段 3 で扱う）。
    for it in range(30):
        grp, G, G0 = build(bidx)
        RS, RE, RP = runs_of(grp, G)
        RG = grp[rows][RS]
        NB = bidx.size
        bl, br = au[gs[bidx]], aw[gs[bidx]]
        sg_, wi_, _ = _ragged(sz[bidx])
        abub = np.full(n, -1, np.int64)
        abub[al[gs[bidx][sg_] + wi_]] = sg_
        runid = np.repeat(np.arange(RS.size), RE - RS)
        isfl = np.zeros(n, bool); isfl[bl] = True; isfl[br] = True
        mF = isfl[rows]
        kF = np.unique(runid[mF].astype(np.int64) * n + rows[mF])
        nvis = np.bincount(kF % n, minlength=n)          # 側面を通る区間の数
        totF = np.bincount(rows[mF], minlength=n)        # 側面の通過回数
        ab = abub[rows]
        mA = ab >= 0
        kA = np.unique(runid[mA].astype(np.int64) * NB + ab[mA])
        ra = np.bincount(kA % NB, minlength=NB)          # バブルの中を通る区間の数
        drop = ((nvis[bl] != ra) | (nvis[br] != ra)
                | (totF[bl] != nvis[bl]) | (totF[br] != nvis[br]))
        if not drop.any():
            _log(t0, f"  条件2: 収束（{it} 回）")
            break
        _log(t0, f"  条件2 検査 {it}: 畳めないバブル {int(drop.sum()):,}"
                 f"（側面は通るがアレルを通らない {int(((nvis[bl]!=ra)|(nvis[br]!=ra)).sum()):,}"
                 f" / 反復 {int(((totF[bl]!=nvis[bl])|(totF[br]!=nvis[br])).sum()):,}）")
        bidx = bidx[~drop]
    R = RS.size

    _log(t0, f"グループ {G:,}（連鎖 {G0:,} + 単独 {G - G0:,}）= 元の {100 * G / n:.1f}% "
             f"/ 畳むバブル {bidx.size:,} / 区間 {R:,}")

    # ── 3. 区間の向きと代表区間 ──────────────────────────────────
    #   ★区間の向きは「ステップの向きの多数決」では決められない。
    #     アレルの向きに引っ張られて、鎖を完全に逆走している区間を順方向と誤判定する
    #     （実測: 側面 3 個が全部反転しているのに、アレル 4 個の '+' に票で負けた）。
    #     代表区間が定める**鎖の中での位置**で決める。最初と最後のノードの位置を比べれば一意。
    first = np.full(G, -1, np.int64)
    best = np.zeros(G, np.int64)
    for i in range(R):
        L = RE[i] - RS[i]
        if L > best[RG[i]]:
            best[RG[i]], first[RG[i]] = L, i
    okf = first >= 0
    chain_idx = np.full(n, -1, np.int64)
    chain_ori = np.zeros(n, np.int8)
    fi0 = first[okf]
    sgc, wic, _ = _ragged(RE[fi0] - RS[fi0])
    tc = RS[fi0][sgc] + wic
    chain_idx[rows[tc]] = wic                       # 代表区間内での何番目か
    chain_ori[rows[tc]] = p_ori[tc]
    a_idx = chain_idx[rows[RS]]
    b_idx = chain_idx[rows[RE - 1]]
    RO = np.where(a_idx != b_idx, (a_idx < b_idx).astype(np.int8),
                  (p_ori[RS] == chain_ori[rows[RS]]).astype(np.int8)).astype(np.int8)
    RO[(a_idx < 0) | (b_idx < 0)] = 1               # 代表に出ないノードで始終する区間（保険）
    order = np.argsort(RG, kind="stable")
    gptr = np.searchsorted(RG[order], np.arange(G + 1))
    row_of_run = np.empty(R, np.int64)
    row_of_run[order] = np.arange(R) - gptr[RG[order]]
    nrun_g = np.diff(gptr)

    # ── 4. 鎖の構造で座標系を作る（★bp の累積では位置を決めない）──
    #   構造条件により、どの区間も「側面とスロットを 1 回ずつ、同じ順で」通る。
    #   だから bp を数えずに**添字**でスロットとアレルを対応させられる。
    #   ノード = [側面][スロット][側面][スロット]… で、スロット幅 = 最長アレル。
    ab = abub[rows]
    runid = np.repeat(np.arange(R), RE - RS)
    arows = np.flatnonzero(ab >= 0)                  # 全アレルステップ（大域の順）
    arun = runid[arows]
    fa = np.searchsorted(arun, np.arange(R))
    rank = np.arange(arows.size) - fa[arun]          # 区間内での何番目のアレルか
    nal = np.bincount(arun, minlength=R)
    kg = np.zeros(G, np.int64)
    kg[okf] = nal[first[okf]]                        # グループのスロット数（代表区間から）
    ok_run = nal == kg[RG]
    if not ok_run.all():
        badg = np.unique(RG[~ok_run])
        _log(t0, f"  ★アレル数が代表と合わない区間 {int((~ok_run).sum()):,} / "
                 f"グループ {badg.size:,} → そのグループのバブルを外して作り直す必要がある")
    gslot0 = np.zeros(G + 1, np.int64)
    np.cumsum(kg, out=gslot0[1:])
    NS = int(gslot0[-1])
    slot = np.where(RO[arun] == 1, rank, kg[RG[arun]] - 1 - rank)   # 逆向き区間は順序も反転
    gsl = gslot0[RG[arun]] + slot                                    # 大域スロット番号
    anode = rows[arows]
    aori = np.where(RO[arun] == 1, p_ori[arows], 1 - p_ori[arows]).astype(np.int8)
    alen = s_bp[anode]

    # スロットの最大長（= スロット幅）と多数派アレル
    o1 = np.argsort(gsl, kind="stable")
    gs1 = gsl[o1]
    st1 = np.flatnonzero(np.r_[True, gs1[1:] != gs1[:-1]])
    slotmax = np.zeros(NS, np.int64)
    slotmax[gs1[st1]] = np.maximum.reduceat(alen[o1], st1)
    key = gsl * np.int64(n + 1) + anode
    o2 = np.argsort(key, kind="stable")
    ks = key[o2]
    st2 = np.flatnonzero(np.r_[True, ks[1:] != ks[:-1]])
    cnt2 = np.diff(np.r_[st2, ks.size])
    sl2, nd2, or2 = gsl[o2][st2], anode[o2][st2], aori[o2][st2]
    o3 = np.lexsort((-cnt2, sl2))
    sl3 = sl2[o3]
    keep = np.r_[True, sl3[1:] != sl3[:-1]]
    maj_node = np.zeros(NS, np.int64); maj_ori = np.ones(NS, np.int8)
    maj_node[sl3[keep]] = nd2[o3][keep]
    maj_ori[sl3[keep]] = or2[o3][keep]
    _log(t0, f"スロット {NS:,} / 幅 中央値 {int(np.median(slotmax)) if NS else 0} "
             f"/ 最大 {int(slotmax.max()) if NS else 0} / "
             f"indel を含む {int((slotmax != s_bp[maj_node]).sum()):,}")

    # ── 5. ノード配列（側面はそのまま、スロットは多数派アレル）──
    #   代表区間は RO=1（canon の定義より）なので、その中でのアレルの出現順 = スロット番号。
    fi = first[okf]                                   # グループ昇順に並んだ代表区間
    gi = np.flatnonzero(okf)                          # 対応するグループ id
    sg_, wi_, _ = _ragged(RE[fi] - RS[fi])
    tsel = RS[fi][sg_] + wi_                          # 代表区間の全ステップ（グループ順）
    e_is_al = ab[tsel] >= 0
    e_node = rows[tsel].copy()
    e_ori = p_ori[tsel].copy()
    # 代表区間のアレルステップ -> そのスロットの大域番号
    a_gidx = sg_[e_is_al]
    a_first = np.searchsorted(a_gidx, np.arange(fi.size))
    gsl_rep = gslot0[gi][a_gidx] + (np.arange(a_gidx.size) - a_first[a_gidx])
    pos_al = np.flatnonzero(e_is_al)
    e_node[pos_al] = maj_node[gsl_rep]                # 多数派アレルで置き換える
    e_ori[pos_al] = maj_ori[gsl_rep]
    e_len = s_bp[e_node]
    # グループ内オフセット
    coff = np.zeros(e_len.size + 1, np.int64)
    np.cumsum(e_len, out=coff[1:])
    gstart = np.searchsorted(sg_, np.arange(fi.size + 1))
    e_off = coff[:-1] - coff[gstart[:-1]][sg_]
    replen = np.zeros(G, np.int64)
    replen[gi] = coff[gstart[1:]] - coff[gstart[:-1]]
    rep_off = np.zeros(G + 1, np.int64)
    np.cumsum(replen, out=rep_off[1:])
    repcat = np.frombuffer(b"N", np.uint8).repeat(int(rep_off[-1])).copy()
    val, _ = _step_bases_arr(seqa, seq_off, s_bp, COMP, e_node, e_ori)
    sg2, wi2, _ = _ragged(e_len)
    repcat[rep_off[gi][sg_][sg2] + e_off[sg2] + wi2] = val
    _log(t0, f"代表配列 総 {int(rep_off[-1]):,} bp（スロットは多数派アレル）")
    cols = np.zeros(NS, np.int64)
    colw = np.zeros(NS, np.int64)
    cols[gsl_rep] = e_off[pos_al]                     # スロットのノード内オフセット
    colw[gsl_rep] = e_len[pos_al]                     # ノードでの幅（多数派アレルの長さ）

    # ── 6. 辺 ───────────────────────────────────────────────────
    sp = RP[:-1] == RP[1:]
    eu, ev = RG[:-1][sp], RG[1:][sp]
    ou, ov = RO[:-1][sp].astype(np.int64), RO[1:][sp].astype(np.int64)
    S2 = np.int64(2 * G + 2)
    uk = np.unique(np.minimum((eu * 2 + ou) * S2 + (ev * 2 + ov),
                              (ev * 2 + (1 - ov)) * S2 + (eu * 2 + (1 - ou))))
    E1, E2 = uk // S2, uk % S2
    E_u, E_ou, E_v, E_ov = E1 // 2, (E1 % 2).astype(np.int8), E2 // 2, (E2 % 2).astype(np.int8)
    _log(t0, f"辺 {E_u.size:,}")

    # ── 7. セル（区間 × スロット。短いアレルは '-' で詰める）──
    csm = np.zeros(NS + 1, np.int64); np.cumsum(slotmax, out=csm[1:])
    rowstride = csm[gslot0[1:]] - csm[gslot0[:-1]]
    cellbase = np.zeros(G + 1, np.int64); np.cumsum(nrun_g * rowstride, out=cellbase[1:])
    cells = np.full(int(cellbase[-1]), 0x2D, np.uint8)          # '-'
    gg = RG[arun]
    dst = (cellbase[gg] + row_of_run[arun] * rowstride[gg]
           + (csm[gsl] - csm[gslot0[gg]]))
    av, aoff = _step_bases_arr(seqa, seq_off, s_bp, COMP, anode, aori)
    sg3, wi3, _ = _ragged(alen)
    cells[dst[sg3] + wi3] = av
    _log(t0, f"セル {int(cellbase[-1]):,}（区間 {R:,} × スロット）")

    # 元ノード -> 畳み込みノードの対応（検索用）
    node_off = np.zeros(n, np.int64); node_ori = np.ones(n, np.int8)
    node_off[e_node] = e_off; node_ori[e_node] = e_ori
    node_off[anode] = cols[gsl]; node_ori[anode] = aori
    nvar = int((slotmax > 0).sum())

    # ── 8. 書き出し ─────────────────────────────────────────────
    SIGNB = [b"-", b"+"]
    with open(out_gfa, "wb") as fh:
        fh.write(b"H\tVN:Z:1.0\n")
        parts = []
        for g in range(G):
            parts.append(b"S\t%d\t%s\n" % (g + 1, repcat[rep_off[g]:rep_off[g+1]].tobytes() or b"N"))
            if len(parts) >= 100000:
                fh.write(b"".join(parts)); parts = []
        fh.write(b"".join(parts))
        for c0 in range(0, E_u.size, 200000):
            c1 = min(c0 + 200000, E_u.size)
            fh.write(b"".join(b"L\t%d\t%s\t%d\t%s\t0M\n"
                              % (E_u[i]+1, SIGNB[E_ou[i]], E_v[i]+1, SIGNB[E_ov[i]])
                              for i in range(c0, c1)))
        path_run_ptr = np.searchsorted(RP, np.arange(P + 1))
        for k in range(P):
            i0_, i1_ = path_run_ptr[k], path_run_ptr[k+1]
            ids = RG[i0_:i1_] + 1
            sgn = np.where(RO[i0_:i1_] == 1, "+", "-")
            fh.write(("P\t%s\t%s\t*\n" % (names[k],
                      ",".join(np.char.add(ids.astype("U9"), sgn).tolist()))).encode())

    sc = Path(sidecar or (str(out_gfa) + ".collapse"))
    _write_sidecar2(sc, t0, G, P, names, s_id, grp, node_off, node_ori, s_bp,
                    RG, RO, path_run_ptr, row_of_run, kg, gslot0, cols, colw,
                    slotmax, csm, cells, cellbase, rowstride, nrun_g,
                    dict(nodes_before=n, nodes_after=G, chain_groups=G0, runs=R,
                         bubbles=int(bidx.size), slots=NS, rep_bp=int(rep_off[-1]),
                         cells=int(cellbase[-1]), indel_max=indel_max,
                         split_repeats=split_repeats,
                         schema="collapse-2"))
    _log(t0, f"-> {out_gfa} / {sc}")
    return sc


def _write_sidecar2(path, t0, G, P, names, s_id, grp, node_off, node_ori, s_bp,
                    RG, RO, path_run_ptr, row_of_run, kg, gslot0, cols, colw,
                    slotmax, csm, cells, cellbase, rowstride, nrun_g, meta):
    """v2 のサイドカー。ノード長が通過ごとに変わるので、スロットの幅を別に持つ。

      node_msa(gid) の意味:
        ncol   スロット数
        cols   int32[ncol]  GFA ノード配列内でのスロット開始位置
        colw   int32[ncol]  GFA ノード配列内でのスロットの幅（多数派アレルの長さ）
        slotw  int32[ncol]  セルでのスロット幅（= 最長アレル。短いものは '-' 詰め）
        cells  uint8[nrun * Σslotw]  各区間のアレル
      復元: GFA ノードを走り、cols[j] から colw[j] バイトを cells の該当スロット
            （'-' を除いたもの）で置き換える。長さが変わってよい。
    """
    _log(t0, "サイドカーを書く…")
    if os.path.exists(path):
        os.unlink(path)
    con = sqlite3.connect(str(path))
    con.executescript(SCHEMA2)
    con.executemany("INSERT INTO orig_node VALUES(?,?,?,?,?)",
                    zip(s_id.tolist(), (grp + 1).tolist(), node_off.tolist(),
                        s_bp.tolist(), node_ori.tolist()))
    run_path = np.repeat(np.arange(P), np.diff(path_run_ptr))
    for k in range(P):
        i0, i1 = int(path_run_ptr[k]), int(path_run_ptr[k + 1])
        con.execute("INSERT INTO path_runs VALUES(?,?,?,?,?,?)",
                    (k, names[k], i1 - i0,
                     (RG[i0:i1] + 1).astype(np.int32).tobytes(),
                     RO[i0:i1].astype(np.uint8).tobytes(),
                     row_of_run[i0:i1].astype(np.int32).tobytes()))
    order = np.argsort(RG, kind="stable")
    gptr = np.searchsorted(RG[order], np.arange(G + 1))
    batch = []
    for g in range(G):
        k = int(kg[g])
        if k == 0 or nrun_g[g] == 0:
            continue
        a, b = int(gslot0[g]), int(gslot0[g + 1])
        rp = np.repeat(np.arange(P), np.diff(path_run_ptr))[order[gptr[g]:gptr[g + 1]]]
        batch.append((g + 1, int(nrun_g[g]), k,
                      cols[a:b].astype(np.int32).tobytes(),
                      colw[a:b].astype(np.int32).tobytes(),
                      slotmax[a:b].astype(np.int32).tobytes(),
                      cells[cellbase[g]:cellbase[g + 1]].tobytes(),
                      rp.astype(np.int32).tobytes()))
        if len(batch) >= 20000:
            con.executemany("INSERT INTO node_msa VALUES(?,?,?,?,?,?,?,?)", batch)
            batch = []
    if batch:
        con.executemany("INSERT INTO node_msa VALUES(?,?,?,?,?,?,?,?)", batch)
    con.executemany("INSERT INTO meta VALUES(?,?)",
                    [(k, json.dumps(v)) for k, v in meta.items()])
    con.commit()
    con.execute("VACUUM")
    con.close()


def main():
    ap = argparse.ArgumentParser(description="自明バブルの連鎖を 1 ノードに畳む（可逆）")
    ap.add_argument("--gfa", help="入力 GFA（--distill と排他）")
    ap.add_argument("--distill", help="distill 済みディレクトリ（--gfa と排他）")
    ap.add_argument("--out", required=True, help="出力 GFA")
    ap.add_argument("--sidecar", help="対応付けサイドカー（既定 <out>.collapse）")
    ap.add_argument("--tmp", default=None, help="distill の作業場所")
    ap.add_argument("--no-wildcard", dest="wildcard", action="store_false", default=True)
    ap.add_argument("--no-split-repeats", dest="split_repeats", action="store_false", default=True,
                    help="区間をノードの再訪で切らない（段3 を無効化）。"
                         "既定では切るので、縦列反復は 1 周が 1 区間になり"
                         "コピー数が『区間が何本あるか』として表現される")
    ap.add_argument("--indel-max", type=int, default=0,
                    help="ノードの中に入れる indel の長さの上限(bp)。既定 0 = 畳まない。"
                         "1bp の欠失挿入でも読み枠がずれるので SNP と同列には扱えず、"
                         "しかも畳んでもノードは 1.4%% しか減らない（chrY MC 実測）ので、"
                         "既定では indel をグラフに残す。0 より大きくすると"
                         "その長さまでの差をノードの中（スロットのギャップ）に入れる")
    ap.add_argument("--rep", choices=["consensus", "ref"], default="consensus",
                    help="代表配列の決め方。consensus=列ごとの多数決（既定。置換を最小化し偏りが無い）/ "
                         "ref=参照パスの塩基（--ref-key。ヒトなど参照座標に揃えたいとき）")
    ap.add_argument("--ref-key", default=None,
                    help="--rep ref で代表にするパス名（先頭一致。例 GRCh38）")
    ap.add_argument("--msa-cap", type=int, default=4_000_000,
                    help="1 ノードの MSA セル数の上限。超えたら省く")
    a = ap.parse_args()
    if bool(a.gfa) == bool(a.distill):
        ap.error("--gfa か --distill のどちらか一方を指定する")

    if a.distill:
        collapse(Path(a.distill), Path(a.out), a.wildcard,
                 Path(a.sidecar) if a.sidecar else None, a.msa_cap, a.rep, a.ref_key,
                 a.indel_max, a.split_repeats)
    else:
        with tempfile.TemporaryDirectory(dir=a.tmp, prefix="collapse.") as td:
            d = Path(td) / "d0"
            subprocess.run([sys.executable, str(Path(__file__).with_name("distill.py")),
                            "--gfa", a.gfa, "--out", str(d)], check=True)
            collapse(d, Path(a.out), a.wildcard,
                     Path(a.sidecar) if a.sidecar else None, a.msa_cap, a.rep, a.ref_key,
                 a.indel_max, a.split_repeats)


if __name__ == "__main__":
    main()
