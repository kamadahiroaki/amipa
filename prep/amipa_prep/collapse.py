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

SCHEMA = """
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
  gid  INTEGER PRIMARY KEY,
  nrun INTEGER NOT NULL,         -- このノードを通る区間の数（= MSA の行数）
  ncol INTEGER NOT NULL,         -- 変異する列の数
  cols BLOB,                     -- int32[ncol]  代表配列内のオフセット（昇順）
  cells BLOB,                    -- uint8[nrun*ncol]  行優先の塩基
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


def _ragged(lens):
    """長さ lens の可変長セグメントを平坦化する (seg, within, off)"""
    off = np.zeros(lens.size + 1, np.int64)
    np.cumsum(lens, out=off[1:])
    seg = np.repeat(np.arange(lens.size), lens)
    return seg, np.arange(off[-1]) - off[seg], off


def collapse(distill: Path, out_gfa: Path, wildcard: bool = True,
             sidecar: Path | None = None, msa_cap: int = 4_000_000,
             rep_mode: str = "consensus", ref_key: str | None = None):
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
    same = np.array([s_bp[al[gs[g]:gs[g] + sz[g]]].min() == s_bp[al[gs[g]:gs[g] + sz[g]]].max()
                     for g in bub], bool)
    _log(t0, f"  条件1: 同長でない(indel) {int((~same).sum()):,} / "
             f"空アレル(側面同士の直接辺) {int(bypass.sum()):,}")
    bidx = bub[same & ~bypass]

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
        RS_, RE_, RP_ = [], [], []
        for k in range(P):
            a, b = p_off[k], p_off[k + 1]
            s2 = g_[a:b]
            chg = np.empty(s2.size, bool)
            chg[0] = True
            np.not_equal(s2[1:], s2[:-1], out=chg[1:])
            np.logical_or(chg[1:], solo[s2[1:]], out=chg[1:])
            st = np.flatnonzero(chg)
            RS_.append(st + a)
            RE_.append(np.append(st[1:], s2.size) + a)
            RP_.append(np.full(st.size, k, np.int64))
        return np.concatenate(RS_), np.concatenate(RE_), np.concatenate(RP_)

    # ── 2. 条件 2: 収束するまで畳めないバブルを外す ──────────────
    cum = np.zeros(T + 1, np.int64)
    np.cumsum(s_bp[rows], out=cum[1:])
    for it in range(30):
        grp, G, G0 = build(bidx)
        RS, RE, RP = runs_of(grp, G)
        RG = grp[rows][RS]
        rl = cum[RE] - cum[RS]
        oo = np.argsort(RG, kind="stable")
        rgs, rls = RG[oo], rl[oo]
        st = np.flatnonzero(np.r_[True, rgs[1:] != rgs[:-1]])
        bad = np.zeros(G, bool)
        bad[rgs[st]] = np.minimum.reduceat(rls, st) != np.maximum.reduceat(rls, st)
        if not bad.any():
            _log(t0, f"  条件2: 収束（{it} 回）")
            break
        # ★畳める条件をバブル自身の性質として書く（鎖の構造を経由しない）:
        #   「そのバブルの側面を通る区間は、全てそのバブルの中を通る」。
        #   鎖の途中からの出入り・端からの抜け・分岐は全部これに含まれる。
        NB = bidx.size
        bl, br = au[gs[bidx]], aw[gs[bidx]]
        sg_, wi_, _ = _ragged(sz[bidx])
        abub = np.full(n, -1, np.int64)
        abub[al[gs[bidx][sg_] + wi_]] = sg_
        runid = np.repeat(np.arange(RS.size), RE - RS)
        inbad = bad[grp[rows]]
        isfl = np.zeros(n, bool)
        isfl[bl] = True
        isfl[br] = True
        mF = isfl[rows] & inbad
        kF = np.unique(runid[mF].astype(np.int64) * n + rows[mF])
        nvis = np.bincount(kF % n, minlength=n)              # 側面を通る区間の数
        totF = np.bincount(rows[mF], minlength=n)            # 側面の通過回数
        ab = abub[rows]
        mA = (ab >= 0) & inbad
        kA = np.unique(runid[mA].astype(np.int64) * NB + ab[mA])
        ra = np.bincount(kA % NB, minlength=NB)              # バブルの中を通る区間の数
        drop = bad[grp[bl]] & ((nvis[bl] != ra) | (nvis[br] != ra)
                               | (totF[bl] != nvis[bl]) | (totF[br] != nvis[br]))
        _log(t0, f"  条件2 検査 {it}: 違反グループ {int(bad.sum()):,} / "
                 f"畳めないバブル {int(drop.sum()):,}")
        if not drop.any():
            drop = bad[grp[bl]]                              # 保険
            _log(t0, f"    (特定できず) グループごと外す {int(drop.sum()):,}")
            if not drop.any():
                break
        bidx = bidx[~drop]
    R = RS.size
    _log(t0, f"グループ {G:,}（連鎖 {G0:,} + 単独 {G - G0:,}）= 元の {100 * G / n:.1f}% "
             f"/ 畳むバブル {bidx.size:,} / 区間 {R:,}")

    # ── 3. 区間の向きと代表区間 ──────────────────────────────────
    cumo = np.zeros(T + 1, np.int64)
    np.cumsum(p_ori, out=cumo[1:])
    rdir = ((cumo[RE] - cumo[RS]) * 2 >= (RE - RS)).astype(np.int8)
    first = np.full(G, -1, np.int64)
    best = np.zeros(G, np.int64)
    for i in range(R):
        L = RE[i] - RS[i]
        if L > best[RG[i]]:
            best[RG[i]], first[RG[i]] = L, i
    canon = np.ones(G, np.int8)
    okf = first >= 0
    canon[okf] = rdir[first[okf]]
    RO = (rdir == canon[RG]).astype(np.int8)

    # ── 4. 代表配列 ─────────────────────────────────────────────
    replen = np.zeros(G, np.int64)
    fi = first[okf]
    replen[okf] = cum[RE[fi]] - cum[RS[fi]]
    rep_off = np.zeros(G + 1, np.int64)
    np.cumsum(replen, out=rep_off[1:])
    repcat = np.frombuffer(b"N", np.uint8).repeat(int(rep_off[-1])).copy()
    # ★代表区間を bp 合計 ≤ CH ずつのまとまりで書く。全長ぶんを一度に展開すると 1 bp あたり int64 の添字配列（seg/within/dstart…）を
    #   同時に 5〜6 本持ち、chr22（809 Mbp）で +24 GB（この段だけで 36 GB）になっていた。まとまりなら数百 MB で済む
    CH = 32_000_000
    cs_ = np.cumsum(replen[RG[fi]])
    bnd = np.unique(np.r_[0, np.searchsorted(cs_, np.arange(CH, int(cs_[-1]) + CH, CH), side="right"), fi.size])
    for a_, b_ in zip(bnd[:-1], bnd[1:]):
        f_ = fi[a_:b_]
        sg_, wi_, _ = _ragged(RE[f_] - RS[f_])
        tsel = RS[f_][sg_] + wi_
        dstart = rep_off[RG[f_]][sg_] + (cum[tsel] - cum[RS[f_]][sg_])
        val, off = step_bases(rows[tsel], p_ori[tsel])
        sg2, wi2, _ = _ragged(s_bp[rows[tsel]])
        repcat[dstart[sg2] + wi2] = val
        del sg_, wi_, tsel, dstart, val, off, sg2, wi2
    nchunk = bnd.size - 1; del cs_, bnd
    _log(t0, f"代表配列 総 {int(rep_off[-1]):,} bp（{nchunk} まとまり）")

    # ── 5. 辺 ───────────────────────────────────────────────────
    sp = RP[:-1] == RP[1:]
    eu, ev = RG[:-1][sp], RG[1:][sp]
    ou, ov = RO[:-1][sp].astype(np.int64), RO[1:][sp].astype(np.int64)
    S2 = np.int64(2 * G + 2)
    uk = np.unique(np.minimum((eu * 2 + ou) * S2 + (ev * 2 + ov),
                              (ev * 2 + (1 - ov)) * S2 + (eu * 2 + (1 - ou))))
    E1, E2 = uk // S2, uk % S2
    E_u, E_ou, E_v, E_ov = E1 // 2, (E1 % 2).astype(np.int8), E2 // 2, (E2 % 2).astype(np.int8)
    _log(t0, f"辺 {E_u.size:,}")

    # ── 6. 置換（区間の通過ごと・位置ごと）＋ 元ノードの対応 ─────
    path_run_ptr = np.searchsorted(RP, np.arange(P + 1))
    mask = BIT[repcat]
    node_off = np.zeros(n, np.int64)
    node_ori = np.ones(n, np.int8)
    S_off, S_key, S_run = [], [], []
    for k in range(P):
        i0, i1 = path_run_ptr[k], path_run_ptr[k + 1]
        a, b = p_off[k], p_off[k + 1]
        rid = np.repeat(np.arange(i0, i1), (RE - RS)[i0:i1])
        v, ori, lens = rows[a:b], p_ori[a:b], s_bp[rows[a:b]]
        g, ro = RG[rid], RO[rid]
        c = cum[a:b] - cum[RS[rid]]
        off_rep = np.where(ro == 1, c, replen[g] - c - lens)
        ori_rep = np.where(ro == 1, ori, 1 - ori).astype(np.int8)
        node_off[v] = off_rep                                  # 検索用（同じ値が入る）
        node_ori[v] = ori_rep
        gpos = rep_off[g] + off_rep
        val, off = step_bases(v, ori_rep)
        seg = np.repeat(np.arange(v.size), lens)
        rval = repcat[gpos[seg] + (np.arange(off[-1]) - off[seg])]
        s = np.flatnonzero(np.logical_or.reduceat(val != rval, off[:-1]))
        S_off.append(off_rep[s])
        S_key.append(v[s] * 2 + ori_rep[s])
        S_run.append(rid[s])
        if s.size:
            sg3, wi3, _ = _ragged(lens[s])
            np.bitwise_or.at(mask, gpos[s][sg3] + wi3, BIT[val[off[s][sg3] + wi3]])
    sub_off = np.concatenate(S_off)
    sub_run = np.concatenate(S_run)
    sub_key = np.concatenate(S_key)
    del S_off, S_run, S_key
    run_ptr = np.zeros(R + 1, np.int64)
    np.cumsum(np.bincount(sub_run, minlength=R), out=run_ptr[1:])
    uk2, inv = np.unique(sub_key, return_inverse=True)
    sub_pool = inv.astype(np.int32)
    pool_val, pool_off = step_bases(uk2 // 2, (uk2 % 2).astype(np.int8))
    isN = BIT[repcat] == 15
    nvar = int(((POPC[mask] > 1) & ~isN).sum())
    nN = int(isN.sum())
    _log(t0, f"置換 {sub_off.size:,} / プール {uk2.size:,} / 区間あたり {sub_off.size / R:.2f}")
    run_path_of = np.repeat(np.arange(P), np.diff(path_run_ptr))
    _log(t0, f"変異する位置 {nvar:,} / N を除く {int(rep_off[-1]) - nN:,} bp "
             f"({100 * nvar / max(1, int(rep_off[-1]) - nN):.3f}%)  ［入力の N {nN:,}］")

    # ── 7. ノード内 MSA を作り、代表配列を列ごとの多数決で決め直す ──
    #    ★代表を「最初のパスの区間」にすると、条件 2 で全区間が同じ長さになる以上
    #      事実上いつもパス 0 が選ばれ、そのハプロタイプだけが畳み込みグラフと一致する
    #      （実測: ecoli50 のパス 0 は相違 501 bp、他は 5.6 万 bp）。
    #      マッピングの基準として偏るうえ、置換の総数も最小でない。
    #      列ごとの多数決は「代表と異なる区間の数」を最小にする最適解。
    order = np.argsort(RG, kind="stable")
    gptr = np.searchsorted(RG[order], np.arange(G + 1))
    row_of_run = np.empty(R, np.int64)
    row_of_run[order] = np.arange(R) - gptr[RG[order]]
    sub_len = (pool_off[np.asarray(sub_pool, np.int64) + 1]
               - pool_off[np.asarray(sub_pool, np.int64)]).astype(np.int64)
    msa = {}
    ncells = nskip = nflip = nref = 0
    for g in range(G):
        rr = order[gptr[g]:gptr[g + 1]]
        if rr.size == 0:
            continue
        cols = set()
        for i in rr:
            for j in range(run_ptr[i], run_ptr[i + 1]):
                o = int(sub_off[j])
                cols.update(range(o, o + int(sub_len[j])))
        if not cols:
            continue
        cols = np.array(sorted(cols), np.int32)
        if rr.size * cols.size > msa_cap:
            nskip += 1
            continue
        pos = {int(c): t for t, c in enumerate(cols)}
        base0 = rep_off[g] + cols
        cells = np.tile(repcat[base0], rr.size)            # まず代表の塩基で埋める
        for t, i in enumerate(rr):
            off0 = t * cols.size
            for j in range(run_ptr[i], run_ptr[i + 1]):
                o, q = int(sub_off[j]), int(sub_pool[j])
                sq = pool_val[pool_off[q]:pool_off[q + 1]]
                for x in range(sq.size):
                    cells[off0 + pos[o + x]] = sq[x]
        # 代表の塩基を決める。ref モードでは参照パスの区間の塩基を採り、
        # 参照がそのノードを通らないところだけ多数決に落ちる。
        M = cells.reshape(rr.size, cols.size)
        pr = run_path_of[rr]
        rrow = -1
        if ref_paths:
            w = np.flatnonzero(np.isin(pr, list(ref_paths)))
            if w.size:
                rrow = int(w[0])
                nref += 1
        for t in range(cols.size):
            if rrow >= 0:
                b = int(M[rrow, t])
            else:
                v, c = np.unique(M[:, t], return_counts=True)
                b = int(v[int(np.argmax(c))])
            if b != repcat[base0[t]]:
                repcat[base0[t]] = b
                nflip += 1
        M = np.where(M == repcat[base0][None, :], np.uint8(0x2E), M)   # '.' = 代表と同じ
        ncells += M.size
        msa[g + 1] = (int(rr.size), int(cols.size), cols, M.reshape(-1),
                      run_path_of[rr].astype(np.int32))
    nsub2 = int(sum((v[3] != 0x2E).sum() for v in msa.values()))
    _log(t0, f"ノード内 MSA: セル {ncells:,} / 省いたノード {nskip} / "
             f"代表を入れ替えた列 {nflip:,}"
             + (f" / 参照が通るノード {nref:,} / MSA を持つノード {len(msa):,}"
                if ref_paths else "（多数決）"))
    _log(t0, f"  代表と異なるセル {nsub2:,}（多数決の前は {int(sub_off.size):,} ステップ分）")

    # ── 8. 書き出し ─────────────────────────────────────────────
    def write_gfa(path, base):
        with open(path, "wb") as fh:
            fh.write(b"H\tVN:Z:1.0\n")
            parts = []
            for g in range(G):
                parts.append(b"S\t%d\t%s\n" % (g + 1, base[rep_off[g]:rep_off[g + 1]].tobytes() or b"N"))
                if len(parts) >= 100000:
                    fh.write(b"".join(parts))
                    parts = []
            fh.write(b"".join(parts))
            for c0 in range(0, E_u.size, 200000):
                c1 = min(c0 + 200000, E_u.size)
                fh.write(b"".join(b"L\t%d\t%s\t%d\t%s\t0M\n"
                                  % (E_u[i] + 1, SIGN[E_ou[i]], E_v[i] + 1, SIGN[E_ov[i]])
                                  for i in range(c0, c1)))
            for k in range(P):
                i0, i1 = path_run_ptr[k], path_run_ptr[k + 1]
                ids = RG[i0:i1] + 1
                sgn = np.where(RO[i0:i1] == 1, "+", "-")
                fh.write(("P\t%s\t%s\t*\n" % (names[k],
                          ",".join(np.char.add(ids.astype("U9"), sgn).tolist()))).encode())

    write_gfa(out_gfa, repcat)
    if wildcard:
        write_gfa(str(out_gfa) + ".wildcard", IUPAC[mask])

    sc = Path(sidecar or (str(out_gfa) + ".collapse"))
    _write_sidecar(sc, t0, G, P, names, s_id, grp, node_off, node_ori, s_bp,
                   RG, RO, path_run_ptr, row_of_run, msa,
                   dict(nodes_before=n, nodes_after=G, chain_groups=G0, runs=R,
                        bubbles=int(bidx.size), subs=nsub2, rep_bp=int(rep_off[-1]),
                        var_pos=nvar, n_bases=nN, msa_cells=ncells, msa_skipped=nskip,
                        rep_flips=nflip, rep_mode=rep_mode,
                        ref_key=ref_key, ref_covered_nodes=nref))
    _log(t0, f"-> {out_gfa}" + (f" / {out_gfa}.wildcard" if wildcard else "") + f" / {sc}")
    return sc


def _write_sidecar(path, t0, G, P, names, s_id, grp, node_off, node_ori, s_bp,
                   RG, RO, path_run_ptr, row_of_run, msa, meta):
    _log(t0, "サイドカーを書く…")
    if os.path.exists(path):
        os.unlink(path)
    con = sqlite3.connect(str(path))
    con.executescript(SCHEMA)
    con.executemany("INSERT INTO orig_node VALUES(?,?,?,?,?)",
                    zip(s_id.tolist(), (grp + 1).tolist(), node_off.tolist(),
                        s_bp.tolist(), node_ori.tolist()))
    for k in range(P):
        i0, i1 = int(path_run_ptr[k]), int(path_run_ptr[k + 1])
        con.execute("INSERT INTO path_runs VALUES(?,?,?,?,?,?)",
                    (k, names[k], i1 - i0,
                     (RG[i0:i1] + 1).astype(np.int32).tobytes(),
                     RO[i0:i1].astype(np.uint8).tobytes(),
                     row_of_run[i0:i1].astype(np.int32).tobytes()))
    batch = []
    for gid, (nrun, ncol, cols, cells, paths) in msa.items():
        batch.append((gid, nrun, ncol, cols.tobytes(), cells.tobytes(), paths.tobytes()))
        if len(batch) >= 20000:
            con.executemany("INSERT INTO node_msa VALUES(?,?,?,?,?,?)", batch)
            batch = []
    if batch:
        con.executemany("INSERT INTO node_msa VALUES(?,?,?,?,?,?)", batch)
    meta = dict(meta, schema="collapse-1")
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
                 Path(a.sidecar) if a.sidecar else None, a.msa_cap, a.rep, a.ref_key)
    else:
        with tempfile.TemporaryDirectory(dir=a.tmp, prefix="collapse.") as td:
            d = Path(td) / "d0"
            subprocess.run([sys.executable, str(Path(__file__).with_name("distill.py")),
                            "--gfa", a.gfa, "--out", str(d)], check=True)
            collapse(d, Path(a.out), a.wildcard,
                     Path(a.sidecar) if a.sidecar else None, a.msa_cap, a.rep, a.ref_key)


if __name__ == "__main__":
    main()
