"""静的JS/CSSの圧縮配信キャッシュ。

static/ 配下の元ソースには一切手を加えず、サーバー側で gzip/brotli 圧縮した
結果をメモリに保持する。ファイルの mtime/size が変わらない限り再圧縮しない
(負荷対策)。brotli は任意依存 (未導入なら gzip のみ)。
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
from collections import OrderedDict
from dataclasses import dataclass, field
from email.utils import formatdate
from pathlib import Path

try:
    import brotli
except ModuleNotFoundError:
    brotli = None  # type: ignore[assignment]

COMPRESSIBLE_SUFFIXES: frozenset[str] = frozenset({".js", ".css"})
CONTENT_TYPES: dict[str, str] = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}
CLIENT_MAX_AGE_SEC = 3600
MAX_CACHE_ENTRIES = 256
MAX_COMPRESS_BYTES = 5 * 1024 * 1024  # これより大きいファイルは恒等で返す

_CACHE: OrderedDict[str, CachedAsset] = OrderedDict()
_STATS: dict[str, int] = {"hits": 0, "misses": 0, "compressions": 0}


@dataclass
class CachedAsset:
    absolute: Path
    mtimeNs: int
    size: int
    etagBase: str
    compressible: bool
    variants: dict[str, bytes] = field(default_factory=dict)

    def fresh(self, mtimeNs: int, size: int) -> bool:
        return self.mtimeNs == mtimeNs and self.size == size


def availableEncodings() -> tuple[str, ...]:
    if brotli is not None:
        return ("br", "gzip")
    return ("gzip",)


def chooseEncoding(acceptEncoding: str) -> str:
    """Accept-Encoding から最適な符号化を選ぶ。q=0 は拒否扱い。どれも使えなければ恒等。"""
    accepted: dict[str, float] = {}
    for item in acceptEncoding.split(","):
        chunks = item.split(";")
        coding = chunks[0].strip().lower()
        if not coding:
            continue
        quality = 1.0
        for param in chunks[1:]:
            name, sep, value = param.strip().partition("=")
            if sep and name.strip().lower() == "q":
                try:
                    quality = max(0.0, min(1.0, float(value)))
                except ValueError:
                    quality = 0.0
        if coding == "*":
            for enc in (*availableEncodings(), "identity"):
                accepted.setdefault(enc, quality)
        else:
            accepted[coding] = quality
    for enc in availableEncodings():
        if accepted.get(enc, 0.0) > 0.0:
            return enc
    return "identity"


def etagFor(asset: CachedAsset, encoding: str) -> str:
    return f'"{asset.etagBase}-{encoding}"'


def lastModified(asset: CachedAsset) -> str:
    return formatdate(asset.mtimeNs / 1_000_000_000, usegmt=True)


def contentTypeFor(absolute: Path) -> str:
    return CONTENT_TYPES.get(absolute.suffix.lower(), "application/octet-stream")


def cacheInfo() -> dict[str, object]:
    return {"entries": len(_CACHE), "encodings": availableEncodings(), **_STATS}


def resolveAsset(staticDir: Path, relPath: str) -> Path | None:
    """traversal 対策付きで解決。範囲外・不在・ディレクトリは None。"""
    if not relPath or Path(relPath).is_absolute():
        return None
    base = staticDir.resolve()
    candidate = (base / relPath).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate


def loadVariants(absolute: Path, *, compressible: bool) -> tuple[bytes, dict[str, bytes]]:
    """読み込み+圧縮 (同期。呼び出し側で to_thread すること)。"""
    raw = absolute.read_bytes()
    variants: dict[str, bytes] = {"identity": raw}
    if compressible and len(raw) <= MAX_COMPRESS_BYTES:
        variants["gzip"] = gzip.compress(raw, compresslevel=9, mtime=0)
        if brotli is not None:
            variants["br"] = brotli.compress(raw, quality=11)
    return raw, variants


async def getAsset(staticDir: Path, relPath: str) -> CachedAsset | None:
    """キャッシュ取得。更新検知時のみ再読込・再圧縮する (充填は冪等)。"""
    absolute = await asyncio.to_thread(resolveAsset, staticDir, relPath)
    if absolute is None:
        return None
    try:
        stat = await asyncio.to_thread(absolute.stat)
    except OSError:
        return None
    key = str(absolute)
    entry = _CACHE.get(key)
    if (
        entry is not None
        and entry.absolute == absolute
        and entry.fresh(stat.st_mtime_ns, stat.st_size)
    ):
        _CACHE.move_to_end(key)
        _STATS["hits"] += 1
        return entry
    compressible = absolute.suffix.lower() in COMPRESSIBLE_SUFFIXES
    _raw, variants = await asyncio.to_thread(loadVariants, absolute, compressible=compressible)
    digest = hashlib.sha256(f"{stat.st_mtime_ns}:{stat.st_size}".encode()).hexdigest()[:32]
    entry = CachedAsset(absolute, stat.st_mtime_ns, stat.st_size, digest, compressible, variants)
    if len(variants) > 1:
        _STATS["compressions"] += 1
    _CACHE[key] = entry
    _CACHE.move_to_end(key)
    while len(_CACHE) > MAX_CACHE_ENTRIES:
        _CACHE.popitem(last=False)
    _STATS["misses"] += 1
    return entry
