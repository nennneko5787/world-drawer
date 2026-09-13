"""共有定数。config.jsonc があれば上書き (JSONC = コメント付きJSON)。"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

baseDir = Path(__file__).resolve().parent.parent.parent
pagesDir = baseDir / "pages"
staticDir = baseDir / "static"
dataDir = baseDir / "data"
dbFile = dataDir / "world.db"
configFile = baseDir / "config.jsonc"
# 旧JSON (初回のみSQLiteへ取込)
canvasFile = dataDir / "canvas.json"
usersFile = dataDir / "users.json"
historyFile = dataDir / "history.json"

# ---- ゲームバランス (既定値。config.jsonc で変更可) ----
cooldownSec = 10.0  # Lv1 のクールダウン秒
minCooldown = 1.5  # クールダウンの下限秒
cooldownDecay = 0.87  # クールダウン逓減率 (下限への指数接近。Lv40頃に下限)
xpPerPlace = 1  # 1マス配置ごとの経験値
xpBase = 3  # 必要経験値の係数 (次レベルまで xpBase x Lv^xpPow)
xpPow = 1.5  # 必要経験値の指数 (序盤は軽く後半は重く)
background = "#ffffff"
coordLimit = 1_000_000
maxNameLen = 20
maxBboxPixels = 100000

# ---- 特殊インク (構造に直結するためコード固定) ----
specialInks: dict[str, str] = {
    "glow": "発光",
    "rainbow": "虹色",
    "ghost": "ゴースト",
}
rewardChance = 0.30
rewardMin = 1
rewardMax = 4

# ---- 履歴上限 ----
maxHistoryPerCell = 20
maxHistoryCells = 50000

# ---- アカウント ----
minPasswordLen = 8
maxPasswordLen = 128
sessionPerHour = 30  # IPごとのセッション発行上限
loginMaxFails = 10  # ログイン失敗上限
loginLockSec = 600  # 失敗上限後のロック秒

# ---- 荒らし対策 ----
placePerMinPerIp = 30  # IP共有の配置上限 (家族利用を妨げない程度に緩め)
placeRadius = 1000  # 低レベル時の配置可能半径 (既存ピクセル/他プレイヤーから)
trustedLevel = 5  # このレベル以上は半径制限なし

# 信頼プロキシ (IP/CIDR)。ここからの接続のみ CF-Connecting-IP / X-Forwarded-For
# を信用する。Cloudflare Tunnel (cloudflaredは自ホスト発) なら既定のままでよい。
# 直結公開のヘッダは偽装可能なため無視し、ソケットIPを使う
trustedProxies = ["127.0.0.1", "::1"]

# ---- OGP ----
# 公開URL (og:url / og:image を絶対URLにするため)。空ならリクエストの Host から推定。
# 例: "https://example.com"
siteUrl: str = ""

# ---- config.jsonc の検証表 (キー: (型, 最小, 最大)) ----
_INT_KEYS: dict[str, tuple[int, int]] = {
    "xpPerPlace": (1, 1000),
    "xpBase": (1, 100000),
    "coordLimit": (1000, 100_000_000),
    "maxNameLen": (1, 50),
    "maxBboxPixels": (100, 1000000),
    "maxHistoryPerCell": (1, 200),
    "maxHistoryCells": (100, 1000000),
    "minPasswordLen": (4, 64),
    "maxPasswordLen": (8, 512),
    "sessionPerHour": (1, 10000),
    "loginMaxFails": (1, 1000),
    "loginLockSec": (10, 86400),
    "placePerMinPerIp": (1, 10000),
    "placeRadius": (10, 1000000),
    "trustedLevel": (1, 100),
    "rewardMin": (1, 64),
    "rewardMax": (1, 64),
}
_FLOAT_KEYS: dict[str, tuple[float, float]] = {
    "cooldownSec": (0.5, 3600.0),
    "minCooldown": (0.1, 3600.0),
    "cooldownDecay": (0.5, 1.0),
    "xpPow": (1.0, 3.0),
    "rewardChance": (0.0, 1.0),
}
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def skipJsoncComment(text: str, idx: int) -> int | None:
    """idx がコメント開始なら終了位置を返す。違えば None。"""
    if text[idx] != "/" or idx + 1 >= len(text):
        return None
    nxt = text[idx + 1]
    if nxt == "/":
        end = text.find("\n", idx)
        return len(text) if end == -1 else end
    if nxt == "*":
        end = text.find("*/", idx + 2)
        return len(text) if end == -1 else end + 2
    return None


def dropsTrailingComma(text: str, idx: int) -> bool:
    """idx のカンマが } ] の直前なら True。"""
    look = idx + 1
    while look < len(text) and text[look] in " \t\r\n":
        look += 1
    return look < len(text) and text[look] in "}]"


def stripJsonc(text: str) -> str:
    """// と /* */ コメントを除去 (文字列リテラル内は保持)。"""
    out: list[str] = []
    idx, total = 0, len(text)
    inStr, esc = False, False
    while idx < total:
        ch = text[idx]
        if inStr:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                inStr = False
            idx += 1
            continue
        if ch == '"':
            inStr = True
            out.append(ch)
            idx += 1
            continue
        skipped = skipJsoncComment(text, idx)
        if skipped is not None:
            idx = skipped
            continue
        out.append(ch)
        idx += 1
    return "".join(out)


def removeTrailingCommas(text: str) -> str:
    """} ] 直前の余分なカンマを除去 (文字列リテラル内は保持)。"""
    out: list[str] = []
    idx, total = 0, len(text)
    inStr, esc = False, False
    while idx < total:
        ch = text[idx]
        if inStr:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                inStr = False
            idx += 1
            continue
        if ch == '"':
            inStr = True
            out.append(ch)
            idx += 1
            continue
        if ch == "," and dropsTrailingComma(text, idx):
            idx += 1
            continue
        out.append(ch)
        idx += 1
    return "".join(out)


def validateIntKey(key: str, value: object) -> int | None:
    low, high = _INT_KEYS[key]
    if isinstance(value, bool) or not isinstance(value, int):
        logger.warning("config.jsonc: %s must be int, using default", key)
        return None
    if not low <= value <= high:
        logger.warning("config.jsonc: %s out of range, using default", key)
        return None
    return value


def validateFloatKey(key: str, value: object) -> float | None:
    low, high = _FLOAT_KEYS[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        logger.warning("config.jsonc: %s must be number, using default", key)
        return None
    if not low <= float(value) <= high:
        logger.warning("config.jsonc: %s out of range, using default", key)
        return None
    return float(value)


def validateColorKey(value: object) -> str | None:
    if not isinstance(value, str) or not _HEX_COLOR.match(value):
        logger.warning("config.jsonc: background must be #rrggbb, using default")
        return None
    return value.lower()


def validateProxyList(value: object) -> list[str] | None:
    if not isinstance(value, list):
        logger.warning("config.jsonc: trustedProxies must be a list, using default")
        return None
    nets: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        try:
            nets.append(str(ipaddress.ip_network(item.strip(), strict=False)))
        except ValueError:
            logger.warning("config.jsonc: trustedProxies ignored invalid entry: %s", item)
    return nets


def validateSiteUrl(value: object) -> str | None:
    if not isinstance(value, str):
        logger.warning("config.jsonc: siteUrl must be a string, using default")
        return None
    text = value.strip().rstrip("/")
    if not text:
        return ""
    if not re.match(r"^https?://[^/\s]+$", text):
        logger.warning("config.jsonc: siteUrl must be like https://example.com, using default")
        return None
    return text


def applyConfigKey(
    validated: dict[str, int | float | str | list[str]], key: str, value: object
) -> None:
    """1キー分の検証。通れば validated に格納、ダメなら警告。"""
    if key in _INT_KEYS:
        result: int | float | str | list[str] | None = validateIntKey(key, value)
    elif key in _FLOAT_KEYS:
        result = validateFloatKey(key, value)
    elif key == "background":
        result = validateColorKey(value)
    elif key == "trustedProxies":
        result = validateProxyList(value)
    elif key == "siteUrl":
        result = validateSiteUrl(value)
    else:
        logger.warning("config.jsonc: unknown key ignored: %s", key)
        return
    if result is not None:
        validated[key] = result


def loadConfigFile() -> None:
    """config.jsonc を読んで既定値を上書き。不正値は警告して既定維持。"""
    if not configFile.exists():
        return
    try:
        raw = json.loads(removeTrailingCommas(stripJsonc(configFile.read_text(encoding="utf-8"))))
    except (OSError, ValueError) as err:
        logger.warning("config.jsonc parse error, using defaults: %s", err)
        return
    if not isinstance(raw, dict):
        logger.warning("config.jsonc root must be an object, using defaults")
        return
    validated: dict[str, int | float | str | list[str]] = {}
    for key, value in raw.items():
        applyConfigKey(validated, key, value)
    rewardMinVal = validated.get("rewardMin", rewardMin)
    rewardMaxVal = validated.get("rewardMax", rewardMax)
    if (
        isinstance(rewardMinVal, int)
        and isinstance(rewardMaxVal, int)
        and rewardMinVal > rewardMaxVal
    ):
        logger.warning("config.jsonc: rewardMin > rewardMax, using defaults")
        validated.pop("rewardMin", None)
        validated.pop("rewardMax", None)
    globals().update(validated)


loadConfigFile()
