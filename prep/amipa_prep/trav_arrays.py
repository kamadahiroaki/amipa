#!/usr/bin/env python3
"""<db>.trav の arrays 表（name, dtype, n, blob）の読み書き（2026-11-03）。

大きな配列は 1 行に入れず、PART バイトごとの行に分ける: 先頭の片は name、続きは name#1, name#2, …（n はどの行にも全体の要素数）。
理由: viewer の backend（better-sqlite3）は 1 つの値を Node の文字列の上限（約 537 MB）までしか読めず、全ゲノムの id_map（int64 × 8,100 万 = 651 MB）で
"string or blob too big" になった。PART は 256 MiB。

使い方（既存の .trav を分けた形に直す。中身は変わらない。新しいファイルへ表ごと写す）:
  python3 trav_arrays.py <x.trav> [<出力。省くと置き換え>]
"""
import os, sqlite3, sys
import numpy as np

PART = 256 << 20


def put_array(cur, nm, arr):
    """配列 arr を name / name#k の行に書く（前の同名の行は消す）"""
    b = np.ascontiguousarray(arr).tobytes(); dt = str(arr.dtype); n = int(arr.size)
    cur.execute("DELETE FROM arrays WHERE name = ? OR name GLOB ?", (nm, nm + "#*"))
    for k, o in enumerate(range(0, max(1, len(b)), PART)):
        cur.execute("INSERT INTO arrays VALUES (?,?,?,?)", (nm if k == 0 else f"{nm}#{k}", dt, n, b[o:o + PART]))


def get_array(con, nm):
    """name と name#k の行をつないで numpy 配列に。無ければ None"""
    rows = con.execute("SELECT name, dtype, blob FROM arrays WHERE name = ? OR name GLOB ?", (nm, nm + "#*")).fetchall()
    if not rows: return None
    rows.sort(key=lambda r: 0 if r[0] == nm else int(r[0].rsplit("#", 1)[1]))
    return np.frombuffer(b"".join(r[2] for r in rows), np.dtype(rows[0][1]))


def split_file(path, out=None):
    """path の .trav を、大きな配列を分けた形で新しいファイルに書き直す（out を省くと path を置き換える）。
    元のファイルの中で行を書き直すと、消した行の跡に新しい行が散らばり、配列 1 本の読み出しが 4 KB のランダム読みになった（全ゲノムで MSA の抽出が止まった、11-03）。
    新しいファイルへ表ごと写すので、どの表も物理的に連続する"""
    src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    names = sorted({r[0].split("#")[0] for r in src.execute("SELECT name FROM arrays")})
    dst_path = out or path
    tmp = dst_path + ".split.tmp"
    if os.path.exists(tmp): os.remove(tmp)
    dst = sqlite3.connect(f"file:{tmp}", uri=True); dst.execute("PRAGMA journal_mode=OFF"); dst.execute("PRAGMA synchronous=OFF"); dst.execute("ATTACH ? AS s", (f"file:{path}?mode=ro",))
    for name, sql in src.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").fetchall():
        dst.execute(sql)
        if name != "arrays": dst.execute(f'INSERT INTO main."{name}" SELECT * FROM s."{name}"')
    cur = dst.cursor()
    for nm in names:
        a = get_array(src, nm); put_array(cur, nm, a)
        print(f"{nm}: {a.nbytes / 1e6:.0f} MB → {max(1, -(-a.nbytes // PART))} 行", flush=True)
    for (sql,) in src.execute("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").fetchall(): dst.execute(sql)
    dst.commit(); dst.execute("DETACH s"); dst.close(); src.close()
    os.replace(tmp, dst_path)


if __name__ == "__main__":
    split_file(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
