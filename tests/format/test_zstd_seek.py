#!/usr/bin/env python3
"""seekable zstd 容器の単体試験。外部データも DB も要らない（数秒）。

守るもの:
  ・書いたオフセットで**その行が**返る（索引と実体がずれない）
  ・`zstd -d` で普通に伸長できる（末尾のシークテーブルが読み飛ばされる）
  ・フレームを跨ぐ長い行、先頭・末尾、フレーム境界ちょうど
  ・キャッシュを溢れさせても結果が変わらない
  ・旧アトラス（BGZF 実体 + read_src.bgzf_path）の読み出し経路

`amipa/tests/run.sh format` から呼ばれる。単体で `python3 test_zstd_seek.py` も可。
"""
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "prep", "amipa_prep"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "viewer", "scripts"))

from zstd_seek import (SeekableZstdWriter, SeekableZstdReader,  # noqa: E402
                       looks_seekable, DEFAULT_FRAME_BYTES)

FAIL = []


def check(cond, label, detail=""):
    print(f"  {'OK  ' if cond else 'NG  '}{label}{('  ' + detail) if detail and not cond else ''}")
    if not cond:
        FAIL.append(label)


def make_lines(n, rng):
    """GAF に似た行を作る。長さをばらけさせ、フレーム境界の当たり方を変える。"""
    out = []
    for i in range(n):
        k = rng.choice([20, 200, 2000, 20000])
        path = "".join(f">{rng.randint(1, 99999999)}" for _ in range(max(1, k // 40)))
        out.append(f"read{i}\t{k}\t0\t{k}\t+\t{path}\t{k}\t0\t{k}\t{k}\t{k}\t60\tcs:Z::{k}\n".encode())
    return out


def test_roundtrip(tmp):
    rng = random.Random(7)
    lines = make_lines(4000, rng)
    path = os.path.join(tmp, "a.gaf.zst")
    w = SeekableZstdWriter(path, frame_bytes=64 * 1024, level=6)
    offs = [w.write_line(l) for l in lines]
    w.close()

    check(looks_seekable(path), "シークテーブルがある")
    r = SeekableZstdReader(path, cache=2)          # わざと小さいキャッシュ
    check(r.total == sum(len(l) for l in lines), "非圧縮の総長が一致",
          f"{r.total} != {sum(len(l) for l in lines)}")
    bad = sum(1 for i, l in enumerate(lines) if r.read_line(offs[i]) != l)
    check(bad == 0, f"全 {len(lines)} 行を索引で引いて一致", f"不一致 {bad}")

    # 先頭・末尾・ランダム（順不同で引いてもキャッシュが壊れないこと）
    idx = [0, len(lines) - 1] + rng.sample(range(len(lines)), 200)
    rng.shuffle(idx)
    check(all(r.read_line(offs[i]) == lines[i] for i in idx), "順不同・端でも一致")

    # フレーム境界: 各フレームの先頭に当たる行を全部引く
    heads = set()
    for f in range(r.n_frames):
        u = r.uoff[f]
        j = min(range(len(offs)), key=lambda k: abs(offs[k] - u))
        heads.add(j)
    check(all(r.read_line(offs[j]) == lines[j] for j in heads),
          f"フレーム先頭 {len(heads)} 箇所で一致")
    r.close()

    # 素の zstd で伸長できるか（skippable frame を読み飛ばせるか）
    try:
        dec = subprocess.run(["zstd", "-dcq", path], capture_output=True).stdout
        check(dec == b"".join(lines), "zstd -dc で全体一致")
    except FileNotFoundError:
        print("  --  zstd コマンドが無いので伸長試験は省略")


def test_long_line(tmp):
    """1 行がフレームより長いとき（フレームは行の切れ目でだけ閉じるので跨がない）。"""
    path = os.path.join(tmp, "b.gaf.zst")
    big = (b"x" * (DEFAULT_FRAME_BYTES * 3)) + b"\n"
    lines = [b"short\n", big, b"tail\n"]
    w = SeekableZstdWriter(path, frame_bytes=DEFAULT_FRAME_BYTES, level=3)
    offs = [w.write_line(l) for l in lines]
    w.close()
    r = SeekableZstdReader(path)
    check(all(r.read_line(offs[i]) == lines[i] for i in range(3)),
          "フレームより長い行も引ける")
    r.close()


def test_empty_and_errors(tmp):
    path = os.path.join(tmp, "c.gaf.zst")
    w = SeekableZstdWriter(path, frame_bytes=1 << 16, level=1)
    off = w.write_line(b"only\n")
    w.close()
    r = SeekableZstdReader(path)
    check(r.read_line(off) == b"only\n", "1 行だけの容器")
    try:
        r.read_line(r.total + 10)
        check(False, "範囲外のオフセットで例外")
    except ValueError:
        check(True, "範囲外のオフセットで例外")
    r.close()
    # seekable でないファイルは弾く
    plain = os.path.join(tmp, "d.bin")
    open(plain, "wb").write(b"not a zstd file at all")
    check(not looks_seekable(plain), "seekable でないファイルを弾く")


def test_legacy_bgzf(tmp):
    """旧アトラス（read_src.bgzf_path + BGZF 実体）を今のコードで読めるか。"""
    try:
        from Bio import bgzf
    except ImportError:
        print("  --  biopython が無いので旧 BGZF 経路は省略")
        return
    import sqlite3
    import reads_query as rq

    bg = os.path.join(tmp, "HGX.gaf.gz")
    lines = [f"r{i}\t100\t0\t100\t+\t>1>2>3\t300\t0\t100\t100\t100\t60\tcs:Z::100\n".encode()
             for i in range(300)]
    w = bgzf.BgzfWriter(bg, "wb")
    voffs = []
    for l in lines:
        voffs.append(w.tell())
        w.write(l)
    w.close()

    side = os.path.join(tmp, "old.reads")
    c = sqlite3.connect(side)
    c.execute("CREATE TABLE read_src(sample_no INTEGER PRIMARY KEY, sample_id TEXT, "
              "bgzf_path TEXT, n_reads INTEGER)")
    c.execute("INSERT INTO read_src VALUES(0,'HGX',?,?)", (bg, len(lines)))
    c.execute("CREATE TABLE read_aln(aln_id INTEGER PRIMARY KEY, sample_no INTEGER, "
              "voff INTEGER, read_name TEXT)")
    c.executemany("INSERT INTO read_aln VALUES(?,0,?,?)",
                  [(i + 1, voffs[i], f"r{i}") for i in range(len(lines))])
    c.commit(); c.close()

    con = sqlite3.connect(":memory:")
    con.execute("ATTACH DATABASE ? AS rd", (side,))
    src = rq.read_sources(con)
    check(src[0][1] == "bgzf", "旧スキーマを bgzf と判定する")
    get, _ = rq.open_readers(con, side)
    rows = [(0, i + 1, voffs[i]) for i in (0, 7, 299, 123)]
    got = rq.fetch_lines(get, rows)
    check(all(g[2].encode() == lines[r[1] - 1] for g, r in zip(got, rows)),
          "旧 BGZF 経路でも同じ行が返る")


def main():
    print("## seekable zstd 容器")
    with tempfile.TemporaryDirectory(prefix="amipa-test-") as tmp:
        test_roundtrip(tmp)
        test_long_line(tmp)
        test_empty_and_errors(tmp)
        test_legacy_bgzf(tmp)
    print(f"\n===== {'FAIL: ' + ', '.join(FAIL) if FAIL else 'PASS'}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
