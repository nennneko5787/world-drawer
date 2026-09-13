"""オンラインpresence (メモリのみ。再起動で消える一時情報)。"""

from __future__ import annotations

import time

presence: dict[str, dict] = {}
onlineBySid: dict[str, str] = {}

PRESENCE_TTL_SEC = 30.0


def presenceList() -> list[dict]:
    now = time.time()
    out = []
    for token, item in presence.items():
        if now - float(item.get("updatedAt", 0)) > PRESENCE_TTL_SEC:
            continue
        out.append(
            {
                "token": token,
                "uid": item.get("uid", "?"),
                "name": item.get("name", "ななし"),
                "color": item.get("color", "#22aa66"),
                "x": item.get("x"),
                "y": item.get("y"),
            }
        )
    return out


def presenceEntry(token: str, user: dict) -> dict:
    return {
        "name": user["name"],
        "color": user["color"],
        "uid": user["uid"],
        "x": presence.get(token, {}).get("x"),
        "y": presence.get(token, {}).get("y"),
        "updatedAt": time.time(),
    }
