"""レスポンス・配信イベントモデル (サーバー→クライアント)。"""

from __future__ import annotations

from pydantic import Field

from app.objects.base import StrictModel


class PixelEvent(StrictModel):
    x: int
    y: int
    c: str
    t: str
    by: str | None = Field(default=None)
    coats: int = Field(default=1)
    s: int = Field(default=0)  # シールド残り秒 (0=無保護)
    e: int = Field(default=0)  # チョーク残り秒 (0=永続)


class PresenceItem(StrictModel):
    token: str
    uid: str = Field(default="?")
    name: str = Field(default="ななし")
    color: str = Field(default="#22aa66")
    country: str | None = Field(default=None)
    x: int | None = Field(default=None)
    y: int | None = Field(default=None)
