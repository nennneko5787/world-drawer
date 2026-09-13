"""Pydanticモデル (HTTPボディ + Socket.IOペイロード)。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class PlaceInput(StrictModel):
    """配置ペイロード (HTTP・Socket共通)。"""

    x: int
    y: int
    color: str = Field(default="#000000")
    token: str = Field(default="")
    ink: str | None = Field(default=None)
    inkType: str | None = Field(default=None, alias="type")


class ProfileBody(StrictModel):
    token: str = Field(default="")
    name: str = Field(default="ななし")
    color: str = Field(default="#22aa66")


class AccountIssueBody(StrictModel):
    token: str = Field(default="")
    password: str = Field(default="")


class AccountLoginBody(StrictModel):
    code: str = Field(default="")
    password: str = Field(default="")


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


class SocketCursor(StrictModel):
    token: str = Field(default="")
    x: int
    y: int


class PixelEvent(StrictModel):
    x: int
    y: int
    c: str
    t: str
    by: str | None = Field(default=None)


class PresenceItem(StrictModel):
    token: str
    uid: str = Field(default="?")
    name: str = Field(default="ななし")
    color: str = Field(default="#22aa66")
    x: int | None = Field(default=None)
    y: int | None = Field(default=None)
