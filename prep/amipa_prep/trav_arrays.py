#!/usr/bin/env python3
"""<db>.trav の arrays 表（name, dtype, n, blob）の読み書き（2026-11-03）。

大きな配列は 1 行に入れず、PART バイトごとの行に分ける: 先頭の片は name、続きは name#1, name#2, …（n はどの行にも全体の要素数）。
理由: viewer の backend（better-sqlite3）は 1 つの値を Node の文字列の上限（約 537 MB）までしか読めず、全ゲノムの id_map（int64 × 8,100 万 = 651 MB）で
"string or blob too big" になった。PART は 256 MiB。

使い方（既存の .trav を分けた形に直す。中身は変わらない）:
  python3 trav_arrays.py <x.trav>
"""
import sqlite3, sys
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


def split_file(path):
    con = sqlite3.connect(path); cur = con.cursor()
    big = [r[0] for r in cur.execute("SELECT name FROM arrays WHERE length(blob) > ? AND name NOT GLOB '*#*'", (PART,))]
    for nm in big:
        a = get_array(con, nm); put_array(cur, nm, a.copy()); con.commit()
        print(f"{nm}: {a.nbytes / 1e6:.0f} MB → {-(-a.nbytes // PART)} 行", flush=True)
    if not big: print("分ける配列は無い")
    con.close()


if __name__ == "__main__":
    split_file(sys.argv[1])
