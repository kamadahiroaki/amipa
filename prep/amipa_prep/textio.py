"""入力ファイルを開く共通口（11-17）。.gz と .zst は拡張子で判定して伸長しながら読む。

GFA・GFF・GTF・BED などのテキスト入力は、配布元の圧縮形式のまま渡せるようにここを通す。
"""
import gzip
import io


def is_compressed(path) -> bool:
    p = str(path)
    return p.endswith(".gz") or p.endswith(".bgz") or p.endswith(".zst")


def open_text(path):
    """テキストとして開く（.gz/.bgz は gzip、.zst は zstandard で伸長）。改行はそのまま返す。"""
    p = str(path)
    if p.endswith(".gz") or p.endswith(".bgz"):
        return gzip.open(p, "rt")
    if p.endswith(".zst"):
        import zstandard   # prep イメージの依存に入っている（docker/requirements.txt）
        fh = open(p, "rb")
        return io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh, closefd=True), encoding="utf-8")
    return open(p, "rt")


def strip_ext(name: str) -> str:
    """表示名・既定の DB 名用に圧縮の拡張子を外す（x.gfa.gz → x.gfa）。"""
    for ext in (".gz", ".bgz", ".zst"):
        if name.endswith(ext):
            return name[: -len(ext)]
    return name
