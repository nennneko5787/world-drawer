"""動的OGP画像 (/og-image.png)。画像いっぱいの実キャンバス + 右下ロゴ。

言語非依存 (全言語で同一画像) のため、HTML 側の言語別 meta とは別に
TTL 付きでサーバー側キャッシュする。クローラは画像もキャッシュするので
多少の古さ (TTL 分) は問題にならない。
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass
from email.utils import formatdate
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

from app.services import canvas
from app.services import config as cfg

WIDTH, HEIGHT = 1200, 630
TTL_SEC = 300
CLIENT_MAX_AGE_SEC = 300
MAX_HALF_W = 150
MAX_HALF_H = 80
MIN_HALF_W = 12
MIN_HALF_H = 7
PAD_CELLS = 4
MIN_CELL = 2
MAX_CELL = 48
GRID_COLOR = (233, 233, 233)
AXIS_COLOR = (221, 119, 119)
BADGE_BG = (20, 20, 20, 215)
LOGO_TEXT = "The world drawer"
HEX_LEN = 6
AXIS_WIDE_CELL = 8


@dataclass
class OgpCache:
    png: bytes = b""
    etag: str = '""'
    renderedAt: float = 0.0
    hits: int = 0


_cache = OgpCache()
_lock = asyncio.Lock()


def parseHex(raw: str) -> tuple[int, int, int]:
    text = (raw or "").strip().lstrip("#")
    if len(text) != HEX_LEN:
        return (255, 255, 255)
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError:
        return (255, 255, 255)


def blend(fg: tuple[int, int, int], bg: tuple[int, int, int], alpha: float) -> tuple[int, int, int]:
    inv = 1.0 - alpha
    return (
        round(fg[0] * alpha + bg[0] * inv),
        round(fg[1] * alpha + bg[1] * inv),
        round(fg[2] * alpha + bg[2] * inv),
    )


def windowForBounds(
    count: int, minX: int | None, minY: int | None, maxX: int | None, maxY: int | None
) -> tuple[int, int, int]:
    """原点中心の表示範囲 (halfW, halfH) とセルpxを決める。

    セル数は絵が収まる大きさで決め、画像いっぱいになるよう表示範囲だけ
    広げる (アートは中央に残り、余白はグリッドで埋まる)。はみ出しは描画時に
    クリップされる。
    """
    if not count or minX is None or minY is None or maxX is None or maxY is None:
        halfW, halfH = MIN_HALF_W, MIN_HALF_H
    else:
        halfW = min(MAX_HALF_W, max(abs(minX), abs(maxX), MIN_HALF_W) + PAD_CELLS)
        halfH = min(MAX_HALF_H, max(abs(minY), abs(maxY), MIN_HALF_H) + PAD_CELLS)
    cellsW, cellsH = halfW * 2 + 1, halfH * 2 + 1
    cell = max(MIN_CELL, min(MAX_CELL, WIDTH // cellsW, HEIGHT // cellsH))
    halfW = max(halfW, -(-WIDTH // (2 * cell)))
    halfH = max(halfH, -(-HEIGHT // (2 * cell)))
    return halfW, halfH, cell


def drawBadge(draw: ImageDraw.ImageDraw) -> None:
    """右下ロゴ (ダークバッジ + 地球アイコン + サイト名)。"""
    font = ImageFont.load_default(size=34)
    box = draw.textbbox((0, 0), LOGO_TEXT, font=font)
    textW, textH = box[2] - box[0], box[3] - box[1]
    globeD, gap, padX, padY = 40, 14, 22, 14
    badgeW = padX * 2 + globeD + gap + textW
    badgeH = padY * 2 + max(globeD, textH)
    right, bottom, margin = WIDTH, HEIGHT, 28
    x0, y0 = right - margin - badgeW, bottom - margin - badgeH
    draw.rounded_rectangle([x0, y0, x0 + badgeW, y0 + badgeH], radius=18, fill=BADGE_BG)
    gx, gy = x0 + padX, y0 + (badgeH - globeD) // 2
    draw.ellipse([gx, gy, gx + globeD, gy + globeD], fill=(42, 166, 106))
    draw.ellipse(
        [gx + globeD // 2 - 6, gy + 3, gx + globeD // 2 + 6, gy + globeD - 3],
        outline=(255, 255, 255),
        width=2,
    )
    draw.line(
        [gx + 4, gy + globeD // 2, gx + globeD - 4, gy + globeD // 2],
        fill=(255, 255, 255),
        width=2,
    )
    tx = gx + globeD + gap
    draw.text((tx, y0 + (badgeH - textH) // 2 - box[1]), LOGO_TEXT, font=font, fill=(255, 255, 255))


@dataclass
class OgpView:
    """描画範囲 (原点中心)。left/top は画像内のグリッド左上px。"""

    halfW: int
    halfH: int
    cell: int
    left: int
    top: int
    bg: tuple[int, int, int]


def renderPixels(
    draw: ImageDraw.ImageDraw, pixels: dict[str, dict[str, str]], view: OgpView
) -> None:
    for key, pix in pixels.items():
        try:
            xStr, yStr = key.split(",")
            x, y = int(xStr), int(yStr)
        except ValueError:
            continue
        if abs(x) > view.halfW or abs(y) > view.halfH:
            continue
        color = parseHex(pix.get("c", "#ffffff"))
        if pix.get("t") == "ghost":
            color = blend(color, view.bg, 0.5)
        px = view.left + (x + view.halfW) * view.cell
        py = view.top + (y + view.halfH) * view.cell
        draw.rectangle([px, py, px + view.cell - 1, py + view.cell - 1], fill=color)


def renderPng(pixels: dict[str, dict[str, str]], halfW: int, halfH: int, cell: int) -> bytes:
    bg = parseHex(cfg.background)
    img = Image.new("RGB", (WIDTH, HEIGHT), bg)
    draw = ImageDraw.Draw(img)
    cellsW, cellsH = halfW * 2 + 1, halfH * 2 + 1
    view = OgpView(
        halfW=halfW,
        halfH=halfH,
        cell=cell,
        left=(WIDTH - cellsW * cell) // 2,
        top=(HEIGHT - cellsH * cell) // 2,
        bg=bg,
    )
    for gx in range(cellsW + 1):
        x = view.left + gx * cell
        draw.line([x, view.top, x, view.top + cellsH * cell], fill=GRID_COLOR)
    for gy in range(cellsH + 1):
        y = view.top + gy * cell
        draw.line([view.left, y, view.left + cellsW * cell, y], fill=GRID_COLOR)
    axisW = 2 if cell >= AXIS_WIDE_CELL else 1
    ax = view.left + halfW * cell
    draw.line([ax, view.top, ax, view.top + cellsH * cell], fill=AXIS_COLOR, width=axisW)
    ay = view.top + halfH * cell
    draw.line([view.left, ay, view.left + cellsW * cell, ay], fill=AXIS_COLOR, width=axisW)
    renderPixels(draw, pixels, view)
    drawBadge(draw)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def getOgpImage() -> tuple[bytes, str, float, bool]:
    """(png, etag, renderedAt, cacheHit)。TTL 内は再描画しない。"""
    now = time.time()
    if _cache.png and now - _cache.renderedAt < TTL_SEC:
        _cache.hits += 1
        return _cache.png, _cache.etag, _cache.renderedAt, True
    async with _lock:
        now = time.time()
        if _cache.png and now - _cache.renderedAt < TTL_SEC:
            _cache.hits += 1
            return _cache.png, _cache.etag, _cache.renderedAt, True
        bounds = await canvas.fetchBounds()
        halfW, halfH, cell = windowForBounds(
            int(bounds.get("count", 0)),
            bounds.get("minX"),
            bounds.get("minY"),
            bounds.get("maxX"),
            bounds.get("maxY"),
        )
        pixels, _truncated = await canvas.fetchBbox(-halfW, halfW, -halfH, halfH)
        png = renderPng(pixels, halfW, halfH, cell)
        etag = f'"{hashlib.sha256(png).hexdigest()[:32]}"'
        _cache.png, _cache.etag, _cache.renderedAt = png, etag, now
        return png, etag, now, False


def httpDate(ts: float) -> str:
    return formatdate(ts, usegmt=True)
