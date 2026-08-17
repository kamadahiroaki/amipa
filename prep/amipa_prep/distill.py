#!/usr/bin/env python3
"""distill: GFA を 1 パスで numpy ネイティブ中間表現へ蒸留する(NEW_PIPELINE_SPEC §10.3 案a)。

背景: ②(lod)③(layout)④(emit)が各自 GFA を全走査+Python parse していたのが WG の I/O 律速。
これを 1 度だけ「numpy ネイティブ中間」に蒸留し、各段はその配列を消費する(GFA テキスト parse を
パイプライン全体で 1 回に集約)。各段は自前の text-scan ループを配列ロードに置換するだけで、
下流の numpy 計算は不変 → 出力は構成的に bit-identical。

ノードID densify(密詰め): dense id = 元 int id の「ソート順位(1-based)」。
  - vg snarls(①)と中間の ID 空間を一致させるための前段(§10.2)。① は dense GFA を入力に取る
    (dense=identity のときは元 GFA をそのまま使ってよい)。
  - chr22 PGGB は S 行 id が既に 1..N の連番 → dense=identity(id_map=arange)。この場合 remap は恒等で
    既存 db と bit-identical。minigraph の文字列 id は上流の sed で整数化済み前提(distill は int id を仮定)。
  - id_map[dense-1] = original id。④ は最終 node_name 発行時に id_map で元 id に復元(identity なら無変換)。

入力: GFA(S/L/P/W; 整数 node id)。W 行は MC 用(chr22 は P のみ)。
出力: <out>/ ディレクトリに以下(各段が必要分だけ mmap ロード):
  s_id.npy   [N] int32   S 行(file order)の dense node id
  s_bp.npy   [N] int32   S 行(file order)の bp 長 = len(seq.strip())  (④の max(1,·) は消費側)
  l_a.npy    [E] int32   L 行(file order)端 a の dense id
  l_b.npy    [E] int32   L 行(file order)端 b の dense id
  l_oa.npy   [E] uint8   端 a の向き(+ なら 1, - なら 0)
  l_ob.npy   [E] uint8   端 b の向き(+ なら 1, - なら 0)
  p_off.npy  [P+1] int64 path(P/W, file order)の token CSR オフセット
  p_tok.npy  [T] int32   path token の dense id(向き +/- 除去 = _parse_p_ids と同義)
  p_ori.npy  [T] uint8   path token の向き(P の +/W の > なら 1、-/< なら 0)。p_tok と 1:1 並列。
                         ④ の oriented 走査(ref_strand/逆位)が GFA 再パースせず memmap で消費。
  p_iswalk.npy [P] uint8 W 行なら 1(② は P のみ消費 → iswalk==0 で filter)
  p_names.txt          path 名(1 行 1 名, file order; PanSN grouping は消費側で)
  id_map.npy [N] int64  dense(1..N) -> original id。identity なら arange(1,N+1)
  s_seq.bin  [Σbp] bytes  --emit-seq 時のみ。S 行(file order)の塩基配列を連結した生 bytes。
  s_seq_off.npy [N+1] int64  --emit-seq 時のみ。s_seq.bin への CSR byte offset(file order)。
                         葉 i の配列 = s_seq[off[i]:off[i+1]]。emitter の leaf_seq が GFA 不要で消費。
  meta.json            {N,E,P,T,has_w,has_seq,dense_identity,gfa,...}
"""
import argparse
import json
import os
import sys
import time

import numpy as np

t0 = time.time()


def log(m):
    print(f"[distill +{time.time() - t0:6.1f}s] {m}", flush=True)


def parse_p_ids(field):
    """P 行 segment 列 'id±,id±,...' -> int64 配列(向き ± 除去)。
    layout_emit_db_relayer._parse_p_ids と bit 同一(replace で ± 除去 → fromstring)。"""
    if not field:
        return np.empty(0, dtype=np.int64)
    return np.fromstring(field.replace("+", "").replace("-", ""), sep=",", dtype=np.int64)


def parse_p_ori(field):
    """P 行 segment 列 'id±,id±,...' -> 向き uint8 配列(+ が 1、- が 0)。id は数字のみ、
    区切りは ','。したがって field 中の '+'/'-' バイトが各 token に厳密 1 個ずつ対応する
    (parse_p_ids と同じ長さ)。完全ベクトル化(Python token ループなし)。"""
    if not field:
        return np.empty(0, dtype=np.uint8)
    b = np.frombuffer(field.encode("ascii"), dtype=np.uint8)
    signs = b[(b == 0x2B) | (b == 0x2D)]          # '+'=0x2B, '-'=0x2D
    return (signs == 0x2B).astype(np.uint8)


def parse_w_ori(field):
    """W 行 walk '>id<id...' -> 向き uint8 配列(> が 1、< が 0)。id は数字のみなので
    field 中の '>'/'<' バイトが各 token に 1 個ずつ対応(W_RE の抽出個数と一致)。"""
    if not field:
        return np.empty(0, dtype=np.uint8)
    b = np.frombuffer(field.encode("ascii"), dtype=np.uint8)
    signs = b[(b == 0x3E) | (b == 0x3C)]          # '>'=0x3E, '<'=0x3C
    return (signs == 0x3E).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gfa", required=True)
    ap.add_argument("--out", required=True, help="出力ディレクトリ prefix")
    ap.add_argument("--emit-dense-gfa", default=None,
                    help="dense≠identity のとき ①(vg snarls)用の dense id GFA をここに書く。"
                         "identity なら書かない(元 GFA をそのまま使えるため)。")
    ap.add_argument("--emit-seq", dest="emit_seq", action="store_true", default=True,
                    help="葉の塩基配列を s_seq.bin(連結生bytes)+s_seq_off.npy(CSR byte offset, file order, N+1)へ"
                         "streaming 出力(既定ON)。emitter の --emit-seq が GFA 不要でこれを読む(WG で 373GB GFA 再読み回避)。"
                         "RAM=O(1)(配列は都度ファイルへ書き出し)。")
    ap.add_argument("--no-emit-seq", dest="emit_seq", action="store_false",
                    help="s_seq を出力しない(distill を小さく保つ)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    # ---- pass 1: S/L を収集し、P/W は token 数だけ数える(token 本体は pass 2 で memmap へ直書き) ----
    # p_tok/p_ori(O(T))を RAM に貯めない → ピーク RAM は O(N+E)、パス/hap 数に非依存(WG 大 hap 対策)。
    s_id_o = []          # S 行 node id(元)
    s_bp = []            # S 行 bp
    la_o = []; lb_o = []  # L 端(元 id)
    loa = []; lob = []    # L 向き(1/0)
    p_len = []            # 各 path の token 数(向き記号バイト個数で厳密カウント=parse_p_ids/ori の長さと一致)
    p_names = []          # path 名
    p_iswalk = []         # W なら 1
    n_p = n_w = 0
    import re
    W_RE = re.compile(r"[<>](\d+)")

    # --emit-seq: 葉配列を S 行パス中に s_seq.bin へ streaming 書き(RAM 非蓄積)。offset は file order の CSR。
    seqf = open(os.path.join(args.out, "s_seq.bin"), "wb") if args.emit_seq else None
    s_seq_off = [0] if args.emit_seq else None      # byte offsets(file order), N+1 entries
    _spos = 0

    with open(args.gfa) as f:
        for ln in f:
            c = ln[0]
            if c == "S":
                p = ln.split("\t", 3)
                s_id_o.append(int(p[1]))
                seq = p[2].strip()
                s_bp.append(len(seq))
                if seqf is not None:
                    b = seq.encode("ascii")
                    seqf.write(b); _spos += len(b)
                    s_seq_off.append(_spos)
            elif c == "L":
                p = ln.split("\t")
                la_o.append(int(p[1])); loa.append(1 if p[2] == "+" else 0)
                lb_o.append(int(p[3])); lob.append(1 if p[4] == "+" else 0)
            elif c == "P":
                parts = ln.rstrip("\n").split("\t")
                if len(parts) < 3:
                    continue
                p_names.append(parts[1])
                # token 数 = '+'/'-' バイト個数(各 token に符号 1 個 → parse_p_ids/parse_p_ori の長さと厳密一致)
                p_len.append(parts[2].count("+") + parts[2].count("-"))
                p_iswalk.append(0); n_p += 1
            elif c == "W":
                parts = ln.rstrip("\n").split("\t")
                if len(parts) < 7:
                    continue
                p_names.append(f"{parts[1]}#{parts[2]}#{parts[3]}")
                # token 数 = '>'/'<' バイト個数(各 token に向き記号 1 個 → W_RE.findall の個数と厳密一致)
                p_len.append(parts[6].count(">") + parts[6].count("<"))
                p_iswalk.append(1); n_w += 1

    if seqf is not None:
        seqf.close()
    N = len(s_id_o); E = len(la_o); P = len(p_names)
    s_id_o = np.asarray(s_id_o, np.int64)
    s_bp = np.asarray(s_bp, np.int64)
    la_o = np.asarray(la_o, np.int64); lb_o = np.asarray(lb_o, np.int64)
    loa = np.asarray(loa, np.uint8); lob = np.asarray(lob, np.uint8)
    # p_off/T は token を連結せず p_len(=各 path token 数)から先に確定する。
    # p_tok は下で memmap へ streaming 書き出し(concat/int64 巨大 temp を作らない → RSS/仮想とも低減、WG でも必須)。
    p_off = np.zeros(P + 1, np.int64)
    if P:
        np.cumsum(np.asarray(p_len, np.int64), out=p_off[1:])
    T = int(p_off[-1]) if P else 0
    log(f"parsed: N(S)={N:,} E(L)={E:,} P={n_p:,} W={n_w:,} paths={P:,} T(tok)={T:,}")

    # ---- densify: dense id = 元 id のソート順位(1-based) ----
    uniq = np.unique(s_id_o)
    if uniq.size != N:
        log(f"WARN: S 行に重複 node id({N - uniq.size} 個) — dense は unique 基準")
    id_map = uniq.astype(np.int64)                    # dense d(1..M) -> original = id_map[d-1]
    M = id_map.size
    identity = bool(M == N and np.array_equal(uniq, np.arange(1, N + 1)))
    log(f"densify: {'identity (dense==original, 1..N 連番)' if identity else f'remap {M} 個の元idを 1..{M} へ密詰め'}")

    def to_dense(a):
        if identity:
            return a
        return (np.searchsorted(uniq, a) + 1).astype(np.int64)

    s_id_d = to_dense(s_id_o)
    la_d = to_dense(la_o); lb_d = to_dense(lb_o)

    # ---- 保存(dtype を絞る: dense id < 2^31, bp/tok も int32) ----
    def sv(name, arr):
        np.save(os.path.join(args.out, name), arr)
    sv("s_id.npy", s_id_d.astype(np.int32))
    sv("s_bp.npy", s_bp.astype(np.int32))
    sv("l_a.npy", la_d.astype(np.int32)); sv("l_b.npy", lb_d.astype(np.int32))
    sv("l_oa.npy", loa); sv("l_ob.npy", lob)
    sv("p_off.npy", p_off)
    # ---- pass 2: GFA を再走査し、各 path の token を parse → dense int32 化して memmap へ直書き ----
    # RAM に O(T) の token 配列を貯めない(pass 1 で本体を作らない)。常駐は 1 path 分の一時 int64(O(path長))のみ
    # → ピーク RAM は O(N+E)、パス/hap 数に非依存(大 hap の WG でも安全)。int64 は「元 GFA の生 id」を安全に
    # 読むためだけで、値域は dense id ≤ M(<2^31)ゆえ書き込みは int32。p_tok/p_ori は p_off を共有(file order)。
    # 両 memmap の VSZ 予約は T*4B+T*1B=T*5B(PGGB T=8.1e9 で ~40GB)。65GB の int64 part を持たない今は
    # s_vmem 内に収まるので同時マップし 1 回の再走査で両方を書く(GFA 読みは pass1+pass2 の計 2 回)。
    ptok_path = os.path.join(args.out, "p_tok.npy")
    pori_path = os.path.join(args.out, "p_ori.npy")
    w  = np.lib.format.open_memmap(ptok_path, mode="w+", dtype=np.int32, shape=(T,))
    wo = np.lib.format.open_memmap(pori_path, mode="w+", dtype=np.uint8, shape=(T,))
    pos = 0
    _FLUSH_EVERY = 512_000_000          # token 数。dirty ページ RSS を有界化(定期 msync で書き戻し)
    _next_flush = _FLUSH_EVERY
    with open(args.gfa) as f:
        for ln in f:
            c = ln[0]
            if c == "P":
                parts = ln.rstrip("\n").split("\t")
                if len(parts) < 3:
                    continue
                tok = parse_p_ids(parts[2])
                n = tok.size
                w[pos:pos + n] = tok if identity else (np.searchsorted(uniq, tok) + 1)
                wo[pos:pos + n] = parse_p_ori(parts[2])
                pos += n
            elif c == "W":
                parts = ln.rstrip("\n").split("\t")
                if len(parts) < 7:
                    continue
                tok = np.asarray([int(x) for x in W_RE.findall(parts[6])], np.int64)
                n = tok.size
                w[pos:pos + n] = tok if identity else (np.searchsorted(uniq, tok) + 1)
                wo[pos:pos + n] = parse_w_ori(parts[6])
                pos += n
            else:
                continue
            if pos >= _next_flush:
                w.flush(); wo.flush()
                _next_flush = pos + _FLUSH_EVERY
    assert pos == T, (pos, T)
    w.flush(); del w
    wo.flush(); del wo
    sv("p_iswalk.npy", np.asarray(p_iswalk, np.uint8))
    sv("id_map.npy", id_map)
    if args.emit_seq:
        # s_seq.bin(連結生bytes)は上で streaming 済。off は N+1(file order, s_id/s_bp と並列)。
        s_seq_off = np.asarray(s_seq_off, np.int64)
        assert s_seq_off.size == N + 1, (s_seq_off.size, N + 1)
        assert int(s_seq_off[-1]) == int(s_bp.sum()), (int(s_seq_off[-1]), int(s_bp.sum()))
        sv("s_seq_off.npy", s_seq_off)
        log(f"s_seq: {N:,} 葉 total_bp={int(s_seq_off[-1]):,} -> s_seq.bin + s_seq_off.npy")
    with open(os.path.join(args.out, "p_names.txt"), "w") as fh:
        fh.write("\n".join(p_names))
        if p_names:
            fh.write("\n")
    meta = dict(N=N, M=int(M), E=E, P=P, n_p=n_p, n_w=n_w, T=T,
                has_w=bool(n_w), has_ori=True, has_seq=bool(args.emit_seq),
                dense_identity=identity, gfa=os.path.abspath(args.gfa))
    with open(os.path.join(args.out, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)

    # ---- dense GFA(① 用): identity でなければ書く ----
    if args.emit_dense_gfa and not identity:
        log(f"emit dense GFA for ① (vg snarls): {args.emit_dense_gfa}")
        _rewrite_dense_gfa(args.gfa, args.emit_dense_gfa, uniq)
    elif args.emit_dense_gfa:
        log("dense=identity → 元 GFA をそのまま ① に使えるので dense GFA は書かない")

    log(f"DONE -> {args.out}/  (meta: {meta})")


def _rewrite_dense_gfa(src, dst, uniq):
    """S/L/P/W の node id を dense(uniq のソート順位)に置換して書き出す。"""
    import re
    W_RE = re.compile(r"([<>])(\d+)")

    def d(x):
        return int(np.searchsorted(uniq, int(x)) + 1)

    with open(src) as f, open(dst, "w") as o:
        for ln in f:
            c = ln[0]
            if c == "S":
                p = ln.split("\t")
                p[1] = str(d(p[1]))
                o.write("\t".join(p))
            elif c == "L":
                p = ln.split("\t")
                p[1] = str(d(p[1])); p[3] = str(d(p[3]))
                o.write("\t".join(p))
            elif c == "P":
                parts = ln.rstrip("\n").split("\t")
                if len(parts) >= 3:
                    toks = parts[2].split(",")
                    parts[2] = ",".join(f"{d(tk[:-1])}{tk[-1]}" if tk else tk for tk in toks)
                o.write("\t".join(parts) + "\n")
            elif c == "W":
                parts = ln.rstrip("\n").split("\t")
                if len(parts) >= 7:
                    parts[6] = W_RE.sub(lambda m: f"{m.group(1)}{d(m.group(2))}", parts[6])
                o.write("\t".join(parts) + "\n")
            else:
                o.write(ln)


if __name__ == "__main__":
    main()
