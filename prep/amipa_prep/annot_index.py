#!/usr/bin/env python3
"""node_annot の被覆索引 idx_na_cov を作る（ggb_annotate.py から分離した段）。

なぜ必要か:
  viewer の描画高速経路(nx=fast)は、アノテーション(band/region/gene)を R-Tree の補助列
  ではなく **node_annot の rowid 点引き**で取る（補助列は ggb_hapidx が R-Tree 構築時に
  焼き込むので、後からアノテを足すと NULL のままになり、そのたびに R-Tree 再構築
  (WG で 1h10m〜1h28m)が要るため）。
  この点引きは被覆索引が無いと gene_blob(平均 51B)を含む太い行を読むことになり、
  chr22 実測で同じ問い合わせが 8.4ms → **2,256ms(269 倍)** に化ける。索引は必須。

なぜ別ジョブか:
  作成自体は速い（chr22 2,779,533 行で temp_store=MEMORY なら 0.98s、FILE で 12.14s。
  PGGB 116.6M 行への外挿で数分〜十数分）。分けるのは時間のためではなく、
  annotate 本体が「最後まで DB に書かない」実装で、長くすると途中失敗で
  全トラック分を失うため。段を短く保つのが目的。
  ★以前ここに「283 秒」と書いていたのは誤り。annotate ログの差分を索引のコストと
    決めつけた数字で、単独で測れば上記のとおり桁が違う。

使い方: ggb_annot_index.py <layered.db> [--drop]
"""
import argparse
import sqlite3
import sys
import time

IDX = "idx_na_cov"
CAND = ("band_id", "gene_cnt", "region_class")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--drop", action="store_true", help="索引を消すだけ")
    a = ap.parse_args()
    con = sqlite3.connect(a.db)
    con.execute("PRAGMA busy_timeout=900000")
    con.execute("PRAGMA cache_size=-2000000")
    # ★temp_store=MEMORY にする。索引の先頭列 node_rowid は表の rowid そのものなので、
    #   表を走査した順がそのまま索引キーの昇順になり **ソートが 1 ラン**で済む。
    #   作業領域は 116.6M 行でも約 2.8GB なのでメモリに収まる。
    #   実測(chr22, 2,779,533 行): FILE 12.14s → MEMORY **0.98s**（12 倍）。
    con.execute("PRAGMA temp_store=MEMORY")

    if a.drop:
        t = time.time()
        con.execute(f"DROP INDEX IF EXISTS {IDX}")
        con.commit()
        print(f"[annot-index] {IDX} を削除 ({time.time() - t:.1f}s)")
        return 0

    have = {r[1] for r in con.execute("PRAGMA table_info(node_annot)")}
    if not have:
        print("[annot-index] node_annot が無い → 何もしない")
        return 1
    cols = [c for c in CAND if c in have]
    if not cols:
        print(f"[annot-index] 対象列が無い (node_annot の列: {sorted(have)})")
        return 1
    n = con.execute("SELECT MAX(rowid) FROM node_annot").fetchone()[0] or 0
    print(f"[annot-index] node_annot {n:,} 行 / 索引列 (node_rowid, {', '.join(cols)})")
    t = time.time()
    con.execute(f"CREATE INDEX IF NOT EXISTS {IDX} ON node_annot(node_rowid, {', '.join(cols)})")
    con.commit()
    print(f"[annot-index] {IDX} 作成 完了 {time.time() - t:.1f}s")
    ok = con.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", (IDX,)).fetchone()
    print(f"[annot-index] 検証: {'あり' if ok else '★無い'}")
    con.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
