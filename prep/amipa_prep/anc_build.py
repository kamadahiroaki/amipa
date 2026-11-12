#!/usr/bin/env python3
"""葉 → 各層の祖先の配列 <db>.anc（2026-11-12）。設計 amipa-lab/plans/viewer-cold-bounded.md ⑦。

使い方: anc_build.py <main.db> <out>.anc [--nodes-npy work/super_nodes.<tag>.npy]

以前の viewer の /route は、矩形の中の層 L のノードから本体（全ゲノム 213 GB）の nodes を parent_name の索引で層ごとに下へたどり、
葉 → 層 L のノードの対応を作っていた（層 13 で初回 12.6 秒）。ここで、葉（dense id ＝ GFA の id）ごとに各層の祖先を前計算する。
コンティグのトークンの番号はほぼ連続するので、/route は層 L の配列を番号の範囲で切り出して 1〜数回読むだけになる。

入力の表: 本体の nodes の (layer_index, 名前の符号, 親の名前の符号)。trav_super.py が work/super_nodes.<大きさ>_<更新時刻>.npy に残したものを使う
  （無ければ本体を走査する）。符号 ＝ 接頭辞（n 0 / G 1 / S 2 / 他 3）× 2^40 ＋ 名前の番号。親は一つ上の層のノード。
出力: 先頭 4096 バイトが JSON の見出し {format, maxlayer, n, layers: {L: offset}}、続いて層 L = 0..maxlayer−1 ごとに uint32 × (n+1)。
  値 ＝ 接頭辞 × 2^30 ＋ 番号（接頭辞 0 n・1 G・2 S）、祖先が無ければ 0xFFFFFFFF。添字は葉の番号（n<番号> の番号）。最深層は葉そのもの（配列なし）
"""
import argparse, json, os, sqlite3, sys, time
import numpy as np

ap = argparse.ArgumentParser(); ap.add_argument("db"); ap.add_argument("out"); ap.add_argument("--nodes-npy")
a = ap.parse_args(); t0 = time.time()
def log(m): print(f"[{time.time()-t0:7.1f}s] {m}", flush=True)
SH = 1 << 40
npy = a.nodes_npy
if not npy:
    st = os.stat(a.db); cand = os.path.join(os.path.dirname(os.path.abspath(a.db)), "work", f"super_nodes.{st.st_size}_{int(st.st_mtime)}.npy")
    npy = cand if os.path.exists(cand) else None
if npy:
    A = np.load(npy); log(f"ノード表 {npy}（{len(A):,} 行）")
else:
    enc = lambda c: f"(CASE substr({c},1,1) WHEN 'n' THEN 0 WHEN 'G' THEN 1 WHEN 'S' THEN 2 ELSE 3 END) * {SH} + CAST(substr({c},2) AS INTEGER)"
    D = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    A = np.array(D.execute(f"SELECT layer_index, {enc('node_name')}, CASE WHEN parent_name IS NULL OR parent_name = '' THEN -1 ELSE {enc('parent_name')} END FROM nodes NOT INDEXED").fetchall(), np.int64)
    log(f"本体を走査 {len(A):,} 行")
lay, code, par = A[:, 0], A[:, 1], A[:, 2]; del A
ML = int(lay.max())
leaf = code[(lay == ML) & ((code >> 40) == 0)] & (SH - 1); N = int(leaf.max()) if len(leaf) else 0
num = code & (SH - 1); pre = code >> 40
assert int(num.max()) < (1 << 30), "名前の番号が 2^30 を超える（uint32 に詰められない）"
assert int(pre.max()) <= 2, "n/G/S 以外の接頭辞がある"
log(f"最深層 {ML}、葉 {len(leaf):,}（最大の番号 {N:,}）")
# 層ごとに 符号 → 親の符号 を引けるよう並べる
by = {}
for l in range(1, ML + 1):
    m = lay == l; c = code[m]; p = par[m]; o = np.argsort(c); by[l] = (c[o], p[o])
cur = np.full(N + 1, -1, np.int64); cur[leaf] = leaf   # 葉の符号（接頭辞 0）
hdr = {"format": 1, "maxlayer": ML, "n": N, "layers": {}}
tmp = a.out + ".tmp"
with open(tmp, "wb") as f:
    f.write(b"\0" * 4096); pos = 4096
    out = {}
    for l in range(ML - 1, -1, -1):
        cs, ps = by[l + 1]; ok = cur >= 0
        i = np.searchsorted(cs, cur[ok]); i = np.minimum(i, len(cs) - 1); hit = cs[i] == cur[ok]
        nxt = np.full(N + 1, -1, np.int64); idx = np.flatnonzero(ok); nxt[idx[hit]] = ps[i[hit]]; cur = nxt
        u = np.full(N + 1, 0xFFFFFFFF, np.uint32); v = cur >= 0; u[v] = ((cur[v] >> 40) << 30 | (cur[v] & (SH - 1))).astype(np.uint32)
        hdr["layers"][str(l)] = pos; f.seek(pos); f.write(u.tobytes()); pos += u.nbytes
        log(f"  層 {l}: 祖先あり {int(v.sum()):,}")
    h = json.dumps(hdr).encode(); assert len(h) < 4096; f.seek(0); f.write(h)
os.replace(tmp, a.out)
log(f"→ {a.out}（{os.path.getsize(a.out) / 1e9:.2f} GB）")
