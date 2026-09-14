"""オンラインpresence (メモリのみ。再起動で消える一時情報)。"""

from __future__ import annotations

import time

presence: dict[str, dict] = {}
onlineBySid: dict[str, str] = {}

PRESENCE_TTL_SEC = 30.0


def filterEntries(data: dict[str, dict]) -> list[dict]:
    """presence辞書から公開用の一覧を作る (Redis取得分にも使う純粋関数)。"""
    now = time.time()
    out = []
    for item in data.values():
        if now - float(item.get("updatedAt", 0)) > PRESENCE_TTL_SEC:
            continue
        out.append(
            {
                "uid": item.get("uid", "?"),
                "name": item.get("name", "ななし"),
                "color": item.get("color", "#22aa66"),
                "level": item.get("level", 1),
                "country": item.get("country") if item.get("showCountry", True) else None,
                "x": item.get("x"),
                "y": item.get("y"),
            }
        )
    return out


def presenceList() -> list[dict]:
    # 注意: セッショントークンは絶対に含めない (全員に公開される情報のため)。
    # 相関IDには公開前提の uid を使う。サーバー内部の辞書キーは token のまま。
    return filterEntries(presence)


def sidsForTokens(tokens: set[str]) -> list[str]:
    """指定トークン群で接続中の Socket.IO セッションID一覧 (マージ通知の宛先用)。

    単体用。マルチワーカー時は shared.sidsForTokens を使うこと。
    """
    return [sid for sid, tok in onlineBySid.items() if tok in tokens]
