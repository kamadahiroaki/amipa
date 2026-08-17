#!/usr/bin/env python3
"""seekable zstd — 行単位のランダム取得ができる zstd 容器（読み書き）。

オンデマンドのリード整列は「巨大な GAF から**1 行だけ**取り出す」用途なので、実体は
**一定サイズの独立フレームに刻んだ zstd** に格納し、フレームの索引（シークテーブル）を
末尾に置く。位置は素の**非圧縮バイトオフセット**で表すので、容器の実装が変わっても
索引（`read_aln.voff`）はそのまま使える。

採用しているのは zstd 公式の **seekable format v0.1.0**（`contrib/seekable_format`）:

    [frame 0][frame 1]...[frame N-1][シークテーブル(skippable frame)]

    シークテーブル:
      Magic            u32le  0x184D2A5E   (zstd の skippable frame。素の zstd は読み飛ばす)
      Frame_Size       u32le  = N*entry + 9
      Entry × N:  Compressed_Size u32le, Decompressed_Size u32le, [Checksum u32le]
      Number_Of_Frames u32le
      Descriptor       u8     bit7 = エントリに Checksum が付く
      Seekable_Magic   u32le  0x8F92EAB1

この形なので **`zstd -d` でそのまま伸長できる**（skippable frame は無視される）し、
seekable format に対応した他実装からも読める。フレームは必ず行の境目で閉じるので、
1 行が 2 フレームにまたがることは無い（読み側は念のため跨ぎにも対応する）。

書き込みは Rust 側（`prep/core/reads_core`）にも同じ実装がある（GAF 1 パス化のため）。
**このファイルが形式の正**で、Rust 側はここを参照して書かれている。
"""
import bisect
import os
import struct
from array import array

SKIPPABLE_MAGIC = 0x184D2A5E
SEEKABLE_MAGIC = 0x8F92EAB1
FOOTER_SIZE = 9                      # N(u32) + descriptor(u8) + magic(u32)
DEFAULT_FRAME_BYTES = 1 << 18        # 非圧縮 256 KiB ごとに 1 フレーム
DEFAULT_LEVEL = 9
# フレーム長の根拠（HiFi の GAF 256MiB で実測、BGZF=deflate6/64KiB を 1.00 とする）:
#   256KiB → 0.88 / 1MiB → 0.86 / 4MiB → 0.85。**大きくしてもほとんど縮まない**一方、
#   1 行を取り出すのに展開する量は比例して増える（0.17ms → 0.67ms → 2.6ms/行）。
#   コールドではどちらもシーク 1 回で決まるので、展開が軽い方を採る。
# 圧縮レベルの根拠: 6→0.91 / 9→0.88 / 12→0.84 / 19→0.75。9 は元データ換算 320MB/s 出て
#   構築の律速にならない。容量を詰めたいときは --level 12〜19（伸長側は遅くならない）。


def _zstd():
    """`zstandard`（python-zstandard）。読み書きどちらでも要る。"""
    try:
        import zstandard
    except ImportError as e:                                     # pragma: no cover
        raise SystemExit("zstandard(python-zstandard) が要る: pip install zstandard "
                         "/ apt install python3-zstandard") from e
    return zstandard


# ───────────────────────────── 書き込み ─────────────────────────────

class SeekableZstdWriter:
    """行を追記し、非圧縮オフセット（＝索引に入れる位置）を返すライタ。

    `write_line()` は**書く前**の非圧縮オフセットを返す。これがそのまま
    `read_aln.voff` になり、`SeekableZstdReader.read_line(voff)` で取り出せる。
    """

    def __init__(self, path, frame_bytes=DEFAULT_FRAME_BYTES, level=DEFAULT_LEVEL,
                 checksum=True):
        zstd = _zstd()
        self.f = open(path, "wb", buffering=1 << 20)
        self.cctx = zstd.ZstdCompressor(level=level, write_checksum=checksum)
        self.frame_bytes = frame_bytes
        self.buf = bytearray()
        self.uoffset = 0            # 現フレーム先頭の非圧縮オフセット
        self.entries = []           # (compressed_size, decompressed_size)

    def write_line(self, data: bytes) -> int:
        """1 行（末尾 \\n 込み）を書き、その行頭の非圧縮オフセットを返す。"""
        off = self.uoffset + len(self.buf)
        self.buf += data
        if len(self.buf) >= self.frame_bytes:     # 行を書き終えた所でだけ閉じる＝跨ぎ無し
            self._flush_frame()
        return off

    def _flush_frame(self):
        if not self.buf:
            return
        c = self.cctx.compress(bytes(self.buf))
        if len(c) > 0xFFFFFFFF or len(self.buf) > 0xFFFFFFFF:
            raise ValueError("フレームが 4GiB を超えた（frame_bytes を小さく）")
        self.f.write(c)
        self.entries.append((len(c), len(self.buf)))
        self.uoffset += len(self.buf)
        self.buf = bytearray()

    def close(self):
        self._flush_frame()
        n = len(self.entries)
        tbl = bytearray()
        for cs, ds in self.entries:
            tbl += struct.pack("<II", cs, ds)
        tbl += struct.pack("<IBI", n, 0, SEEKABLE_MAGIC)
        self.f.write(struct.pack("<II", SKIPPABLE_MAGIC, len(tbl)))
        self.f.write(tbl)
        self.f.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ───────────────────────────── 読み出し ─────────────────────────────

class SeekableZstdReader:
    """非圧縮オフセットを指定して 1 行を取り出すリーダ。

    シークテーブルだけ最初に読み（WG 3 サンプルでも数 MB）、本体はフレーム単位で
    必要な所だけ pread する。直近のフレームは `cache` 個まで持つので、
    **オフセット順にまとめて引く**と 1 フレーム＝1 回の展開で何行でも取れる。
    """

    def __init__(self, path, cache=4):
        zstd = _zstd()
        self.path = path
        self.dctx = zstd.ZstdDecompressor()
        self.fd = os.open(path, os.O_RDONLY)
        self.cache_n = max(1, cache)
        self._cache = {}            # frame_index -> bytes
        self._order = []
        self._load_table()

    def _load_table(self):
        size = os.fstat(self.fd).st_size
        if size < FOOTER_SIZE + 8:
            raise ValueError(f"{self.path}: 小さすぎる（seekable zstd ではない）")
        foot = os.pread(self.fd, FOOTER_SIZE, size - FOOTER_SIZE)
        n, desc, magic = struct.unpack("<IBI", foot)
        if magic != SEEKABLE_MAGIC:
            raise ValueError(f"{self.path}: シークテーブルが無い（seekable zstd ではない）")
        esz = 12 if (desc & 0x80) else 8
        tbl_at = size - FOOTER_SIZE - n * esz
        hdr = struct.unpack("<II", os.pread(self.fd, 8, tbl_at - 8))
        if hdr[0] != SKIPPABLE_MAGIC or hdr[1] != n * esz + FOOTER_SIZE:
            raise ValueError(f"{self.path}: シークテーブルの頭が壊れている")
        raw = os.pread(self.fd, n * esz, tbl_at)
        # 各フレームの開始位置（圧縮側・非圧縮側）を累積で持つ
        self.coff = array("q", bytes(8 * (n + 1)))
        self.uoff = array("q", bytes(8 * (n + 1)))
        self.csize = array("q", bytes(8 * n))
        self.usize = array("q", bytes(8 * n))
        c = u = 0
        for i in range(n):
            cs, ds = struct.unpack_from("<II", raw, i * esz)
            self.coff[i] = c
            self.uoff[i] = u
            self.csize[i] = cs
            self.usize[i] = ds
            c += cs
            u += ds
        self.coff[n] = c
        self.uoff[n] = u
        self.n_frames = n
        self.total = u

    def frame_of(self, uoffset: int) -> int:
        return bisect.bisect_right(self.uoff, uoffset, 0, self.n_frames) - 1

    def _frame(self, i: int) -> bytes:
        b = self._cache.get(i)
        if b is not None:
            return b
        raw = os.pread(self.fd, self.csize[i], self.coff[i])
        b = self.dctx.decompress(raw, max_output_size=self.usize[i])
        self._cache[i] = b
        self._order.append(i)
        while len(self._order) > self.cache_n:
            self._cache.pop(self._order.pop(0), None)
        return b

    def read_line(self, uoffset: int) -> bytes:
        """`uoffset` から次の改行までを（改行込みで）返す。"""
        if not (0 <= uoffset < self.total):
            raise ValueError(f"{self.path}: 範囲外のオフセット {uoffset}（全長 {self.total}）")
        i = self.frame_of(uoffset)
        buf = self._frame(i)
        rel = uoffset - self.uoff[i]
        e = buf.find(b"\n", rel)
        if e >= 0:
            return buf[rel:e + 1]
        out = bytearray(buf[rel:])              # 念のため：フレームを跨いだ行
        while i + 1 < self.n_frames:
            i += 1
            buf = self._frame(i)
            e = buf.find(b"\n")
            if e >= 0:
                out += buf[:e + 1]
                return bytes(out)
            out += buf
        return bytes(out)

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass
        self._cache.clear()
        self._order.clear()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def looks_seekable(path) -> bool:
    """末尾のマジックだけ見て seekable zstd かどうか判定する（軽い）。"""
    try:
        with open(path, "rb") as f:
            f.seek(-FOOTER_SIZE, os.SEEK_END)
            return struct.unpack("<IBI", f.read(FOOTER_SIZE))[2] == SEEKABLE_MAGIC
    except OSError:
        return False
