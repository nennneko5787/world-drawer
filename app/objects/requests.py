"""リクエストモデル (HTTPボディ + Socket.IO受信ペイロード)。"""

from __future__ import annotations

from pydantic import Field

from app.objects.base import StrictModel


class PlaceInput(StrictModel):
    """配置ペイロード (HTTP・Socket共通)。"""

    x: int
    y: int
    color: str = Field(default="#000000")
    token: str = Field(default="")
    ink: str | None = Field(default=None)
    inkType: str | None = Field(default=None, alias="type")
    lang: str | None = Field(default=None)


class ProfileBody(StrictModel):
    token: str = Field(default="")
    name: str = Field(default="ななし")
    color: str = Field(default="#22aa66")
    showCountry: bool | None = Field(default=None)


class AccountIssueBody(StrictModel):
    token: str = Field(default="")
    password: str = Field(default="")


class AccountLoginBody(StrictModel):
    code: str = Field(default="")
    password: str = Field(default="")
    # 引っ越し元端末の現トークン。指定時は統合 (マージ) する。空なら切替のみ。
    fromToken: str = Field(default="")


class UndoBody(StrictModel):
    token: str = Field(default="")
    x: int
    y: int
    prevEmpty: bool = Field(default=False)
    prevC: str = Field(default="#000000")
    prevT: str = Field(default="normal")


class SocketHello(StrictModel):
    token: str = Field(default="")
    name: str | None = Field(default=None)
    color: str | None = Field(default=None)
    lang: str | None = Field(default=None)


class SocketCursor(StrictModel):
    token: str = Field(default="")
    x: int
    y: int
