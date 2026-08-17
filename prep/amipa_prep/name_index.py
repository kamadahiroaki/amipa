#!/usr/bin/env python3
"""ggb_nametri — ノード名の**部分一致**検索を索引で引けるようにする FTS5 trigram 索引を作る。

出力先は 2 通り（hapidx と同じ流儀）:
  --into-db  … 対象 layered.db の中に `nmdict` / `nmfts` を作る（emitter の既定。要 DB 再ビルド）
  既定       … サイドカー DB `<db>.nametri` を作る（既存 DB を書き換えずに後付けできる）
backend は main 側にあればそれを、無ければサイドカーを ATTACH して使う（どちらも無ければ
部分一致だけ従来の全走査にフォールバック＝graceful）。

--------------------------------------------------------------------------------
なぜ必要か（実測: chr22-orig-br3-p100.layered.db = 6.4GB / nodes 6,771,017 行・590MB）
--------------------------------------------------------------------------------
viewer の Find>Node は `node_name LIKE '%q%'` で引いていた。先頭ワイルドカードがあるので
既存の idx_nodes_node_name は原理的に使えず（EQP: `SCAN n`）、nodes 590MB の全走査になる。
ネットワーク FS 上では実効 ~12MB/s しか出ないため **cold 48.7 秒**。しかも葉ノード(layer 12)は
rowid 順で表の末尾に 56% が固まっているので、`n{数字}` を引く＝ほぼ必ず最後まで舐める。
ヒット 0 件（打ち間違い）が最悪ケースで、早期打ち切りが効かず必ず全走査になる。

  ※ 先頭 `%` を外しても直らない。SQLite の LIKE 最適化は「大小無視 LIKE には NOCASE 照合の索引」
    を要求するが node_name は BINARY 照合なので、`LIKE 'n1%'` でも索引の**全走査**に落ちる
    (EQP: `SCAN ... USING COVERING INDEX`)。前方一致を索引シークにするには GLOB か範囲述語が要る。
  ※ 「被覆索引(145MB)だけ走査すれば 4 倍速いのでは」は **cold では逆効果**（実測 57.2 秒）。
    idx_nodes_node_name の 37,358 ページは表のページと交互配置(pageno 21〜214,145)で、
    4KB ランダム読みが ~2.5MB/s まで落ちるため。走査を小さくするのではなく**消す**しかない。

trigram トークナイザは 3 文字以上の LIKE/GLOB パターンを索引で解ける（EQP の `INDEX 0:L0`）。

--------------------------------------------------------------------------------
形（外部コンテンツ FTS5）
--------------------------------------------------------------------------------
  nmdict(nid INTEGER PRIMARY KEY, nm TEXT)                     -- 層をまたいだ**ユニーク名**のみ
  nmfts USING fts5(nm, tokenize='trigram',
                   content='nmdict', content_rowid='nid', columnsize=0)

nodes は (layer_index, node_name) 主キーで同じ名前が層の数だけ現れる（chr22: 6.77M 行 /
5.10M ユニーク名）。索引はユニーク名だけ持てばよく、層ごとの行は後段で
idx_nodes_node_name の点シークで引く。columnsize=0 は FTS5 のランキング用列長表
(`nmfts_docsize`) を作らない指定で、chr22 で 51MB 削れる（LIKE/GLOB 検索には不要）。

  chr22 実測: ビルド 8 秒（名前抽出 45 秒を含めて 1 分弱）/ サイズ 190MB
              部分一致 cold 0.4-1.5s・warm 0.01-0.15s（従来 cold 48.7s）
              ヒット 0 件は 0.00s（従来 48.7s）
"""
import argparse
import os
import random
import sqlite3
import sys
import time

SIDECAR_SUFFIX = ".nametri"
_T0 = time.time()


def log(msg):
    print(f"[nametri {time.time()-_T0:7.1f}s] {msg}", flush=True)


def has_trigram(con):
    """この Python の SQLite が trigram トークナイザを持つか（3.34+ の FTS5 が要る）。"""
    try:
        con.execute("CREATE VIRTUAL TABLE temp._tri_probe USING fts5(x, tokenize='trigram')")
        con.execute("DROP TABLE temp._tri_probe")
        return True
    except sqlite3.OperationalError:
        return False


def iter_names(src_db, chunk=1_000_000):
    """layered.db から**ユニークな** node_name を昇順で流す。

    `SELECT DISTINCT node_name FROM nodes` は idx_nodes_node_name の被覆走査になる
    （node_name しか要らないので rowid 引きは発生しない）。ここは NOT INDEXED にしない:
    ANNOTATE_HOWTO.md が警告する WG の落とし穴は「索引経由で**他の列**を引いて 2 億行分の
    rowid ランダムアクセスになる」ケースで、被覆走査のこれは該当しない。
    """
    con = sqlite3.connect(f"file:{src_db}?mode=ro", uri=True)
    try:
        con.execute("PRAGMA cache_size=-262144")   # 256MB
        cur = con.execute("SELECT DISTINCT node_name FROM nodes WHERE node_name IS NOT NULL")
        while True:
            rows = cur.fetchmany(chunk)
            if not rows:
                return
            yield [r[0] for r in rows]
    finally:
        con.close()


FTS_DDL = ("CREATE VIRTUAL TABLE nmfts USING fts5(nm, tokenize='trigram', "
           "content='nmdict', content_rowid='nid', columnsize=0)")


def build_from_batches(con, batches, on_progress=None):
    """開いている接続 con に nmdict + nmfts を作る。batches = 名前チャンクの反復子。

    **emitter から呼ぶ用の入口**。emitter はノード名をメモリ上で生成できる（名前はノード id の
    純関数 gname(v)）ので、DB を読み直す必要が無い。WG で `SELECT DISTINCT node_name` を
    被覆索引で走査すると、索引ページが表のページと交互配置されているため 4KB ランダム読みに
    なり **実効 2.0MB/s / CPU 7%**（2026-08-03 実測、抽出だけで 40 分超の見込み）。
    LOD 較正を「書き終えた DB に問い合わせ直す」のをやめた経緯（functions/reemit）と同じ理屈。

    ⚠ 重複排除はしない。出現するツリーノードは 1 個につき 1 名で、葉は `n{元id}`・内部は
      `{G|S|X}{v}` なので **元々一意**（接頭辞が違うので葉と内部も衝突しない）。呼び出し側が
      「出現するノードを 1 回ずつ」渡す限り DISTINCT は不要。
    """
    if not has_trigram(con):
        raise SystemExit(
            f"ERROR: この Python の SQLite ({sqlite3.sqlite_version}) は fts5 trigram を持たない。")
    cur = con.cursor()
    cur.execute("DROP TABLE IF EXISTS nmfts")
    cur.execute("DROP TABLE IF EXISTS nmdict")
    cur.execute("CREATE TABLE nmdict(nid INTEGER PRIMARY KEY, nm TEXT)")
    n = 0
    for b in batches:
        cur.executemany("INSERT INTO nmdict(nm) VALUES(?)", ((x,) for x in b))
        n += len(b)
        if on_progress:
            on_progress(n)
    con.commit()
    if n == 0:
        raise SystemExit("ERROR: ノード名が 1 件も渡されなかった")
    cur.execute(FTS_DDL)
    cur.execute("INSERT INTO nmfts(nmfts) VALUES('rebuild')")
    con.commit()
    return n


def verify_con(con, k):
    """開いている接続に対して標本検証する（verify() の中身。emitter からも呼ぶ）。"""
    if k <= 0:
        return True
    pats = sample_patterns(con, k)
    if not pats:
        return True
    sums = ", ".join("SUM(nm LIKE ?)" for _ in pats)
    want = con.execute(f"SELECT {sums} FROM nmdict", pats).fetchone()
    bad = 0
    for pat, w in zip(pats, want):
        got = con.execute("SELECT COUNT(*) FROM nmfts WHERE nm LIKE ?", (pat,)).fetchone()[0]
        if (w or 0) != got:
            log(f"  MISMATCH pat={pat!r} nmdict={w} nmfts={got}")
            bad += 1
    if bad:
        log(f"VERIFY FAILED: {bad}/{len(pats)} mismatches")
        return False
    log(f"verify OK ({len(pats)} substrings: nmfts == nmdict の素の LIKE)")
    return True


def build(src_db, out_db, into_db, page_size, cache_mb):
    """nmdict + nmfts を out_db（into_db なら src_db 自身）へ作る。"""
    if into_db:
        con = sqlite3.connect(src_db)
    else:
        if os.path.exists(out_db):
            os.remove(out_db)
        con = sqlite3.connect(out_db)
        con.execute(f"PRAGMA page_size={page_size}")
    con.execute("PRAGMA synchronous=OFF")
    con.execute("PRAGMA journal_mode=OFF")         # 再生成可能なので耐障害性は不要
    con.execute(f"PRAGMA cache_size=-{cache_mb*1024}")

    if not has_trigram(con):
        raise SystemExit(
            f"ERROR: この Python の SQLite ({sqlite3.sqlite_version}) は fts5 trigram を持たない。\n"
            "       計算ノードの既定 PATH が古い /usr/bin/sqlite3 系を拾っている可能性がある。\n"
            "       miniconda の python3 (3.39.2 で trigram 対応) を明示して実行すること。")

    n = build_from_batches(con, iter_names(src_db),
                           on_progress=lambda k: log(f"  nmdict {k:,} names"))
    log(f"nmdict done: {n:,} unique names / nmfts (trigram) built")
    con.close()
    return n


def sample_patterns(con, k, seed=12345):
    """検証用に、実在する名前から 3 文字以上の部分文字列を k 個サンプルする。"""
    rnd = random.Random(seed)
    names = [r[0] for r in con.execute("SELECT nm FROM nmdict LIMIT 200000").fetchall()]
    pats = []
    while names and len(pats) < k:
        nm = rnd.choice(names)
        if len(nm) < 4:
            continue
        a = rnd.randrange(0, len(nm) - 3)
        pats.append(f"%{nm[a:a + rnd.randrange(3, min(6, len(nm) - a) + 1)]}%")
    return pats


def verify(idx_db, into_db, src_db, k):
    """標本検証: trigram 索引の LIKE 結果が、同じ内容表(nmdict)の素の LIKE と件数一致するか。

    検証対象は「転置索引が nmdict と食い違っていないか」。nmdict 自体が nodes の
    ユニーク名と一致することはビルド時の件数で担保される（同じ 1 回の走査で作っている）。

    ⚠ 素朴に「パターンごとに nodes を全走査して突き合わせる」実装にしていたが、それだと
      k 回のフルスキャンになる。chr22 で 82 秒、**WG(269GB)なら 200 回のフルスキャン**で
      まったく終わらない。ここは `SUM(nm LIKE ?)` を k 個並べて **nmdict を 1 回だけ走査**する。
      （chr22: nmdict 84MB × 1 回。k を増やしても走査回数は 1 のまま。）
    """
    if k <= 0:
        return True
    con = sqlite3.connect(f"file:{idx_db}?mode=ro", uri=True) if not into_db \
        else sqlite3.connect(f"file:{src_db}?mode=ro", uri=True)
    try:
        return verify_con(con, k)
    finally:
        con.close()


def main():
    p = argparse.ArgumentParser(description="node_name 部分一致用 FTS5 trigram 索引を作る")
    p.add_argument("--db", required=True, help="対象 layered.db")
    p.add_argument("--out", help=f"サイドカー出力先（既定: <db>{SIDECAR_SUFFIX}）")
    p.add_argument("--into-db", action="store_true",
                   help="サイドカーではなく対象 DB 内に nmdict/nmfts を作る（emitter の既定）")
    p.add_argument("--page-size", type=int, default=4096, help="サイドカーの page_size")
    p.add_argument("--cache-mb", type=int, default=1024)
    # 検証は nmdict を 1 パス走査して k 個の LIKE を同時に数える（走査回数は k に依らず 1）。
    # ただし 1 行あたりの LIKE 評価が k 回なので、k は総 CPU に線形。chr22(5.1M 名)で
    # k=200 → 48 秒、k=20 → 約 5 秒。索引の破損は少数の標本でも十分に検出できるので既定 20。
    p.add_argument("--verify", type=int, default=20, help="標本検証件数（0 で省略）")
    p.add_argument("--verify-only", action="store_true")
    args = p.parse_args()

    src = os.path.abspath(args.db)
    out = os.path.abspath(args.out) if args.out else src + SIDECAR_SUFFIX
    if not os.path.exists(src):
        raise SystemExit(f"ERROR: 入力が無い: {src}")

    if not args.verify_only:
        log(f"src={src}")
        log(f"dst={'(into-db)' if args.into_db else out}")
        n = build(src, out, args.into_db, args.page_size, args.cache_mb)
        if not args.into_db:
            log(f"size={os.path.getsize(out)/1e6:.1f}MB for {n:,} names")

    ok = verify(out, args.into_db, src, args.verify)
    log("DONE" if ok else "DONE (verify failed)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
