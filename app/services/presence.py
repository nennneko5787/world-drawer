"""オンラインpresence (メモリのみ。再起動で消える一時情報)。"""

from __future__ import annotations

import time

presence: dict[str, dict] = {}
onlineBySid: dict[str, str] = {}

PRESENCE_TTL_SEC = 30.0


def presenceList() -> list[dict]:
    # 注意: セッショントークンは絶対に含めない (全員に公開される情報のため)。
    # 相関IDには公開前提の uid を使う。サーバー内部の辞書キーは token のまま。
    now = time.time()
    out = []
    for item in presence.values():
        if now - float(item.get("updatedAt", 0)) > PRESENCE_TTL_SEC:
            continue
        out.append(
            {
                "uid": item.get("uid", "?"),
                "name": item.get("name", "ななし"),
                "color": item.get("color", "#22aa66"),
                "country": item.get("country") if item.get("showCountry", True) else None,
                "x": item.get("x"),
                "y": item.get("y"),
            }
        )
    return out


def sidsForTokens(tokens: set[str]) -> list[str]:
    """指定トークン群で接続中の Socket.IO セッションID一覧 (マージ通知の宛先用)。"""
    return [sid for sid, tok in onlineBySid.items() if tok in tokens]


def presenceEntry(token: str, user: dict) -> dict:
    return {
        "name": user["name"],
        "color": user["color"],
        "uid": user["uid"],
        "country": user.get("country"),
        "showCountry": user.get("showCountry", True),
        "x": presence.get(token, {}).get("x"),
        "y": presence.get(token, {}).get("y"),
        "updatedAt": time.time(),
    }
