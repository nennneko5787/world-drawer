"""ユーザー管理 (CRUD・UID・認証・レート制限・レベル計算)。"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import random
import re
import secrets
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import aiosqlite

from app.services import config as cfg

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
UID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # 紛らわしい文字 (0/o, 1/l) を除外
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

# ロケールごとの規定表示名。作成者のロケールで固定し、全言語圏にそのまま表示する
ANON_NAMES: dict[str, str] = {
    "ja": "ななし",
    "en": "Anon",
    "ko": "익명",
    "zh-CN": "无名",
    "zh-TW": "無名",
}

sessionHits: dict[str, list[float]] = {}
loginFails: dict[str, list[float]] = {}
ipPlaceHits: dict[str, list[float]] = {}
# 荒らし特定用: token -> 最終配置元IP (配置時に更新。再起動で消える)
lastIpByToken: dict[str, str] = {}
# IP禁止: ip -> 禁止期限 (epoch秒)。再起動で消える
bannedIps: dict[str, float] = {}
_LAST_IP_CAP = 10000


def notePlaceIp(ip: str, token: str) -> None:
    """配置試行の帰属を記録 (荒らしの特定用)。unknown は捨てる。"""
    if not ip or ip == "unknown" or not token:
        return
    lastIpByToken[token] = ip
    if len(lastIpByToken) > _LAST_IP_CAP:
        for old in list(lastIpByToken)[: len(lastIpByToken) - _LAST_IP_CAP]:
            del lastIpByToken[old]


def ipForToken(token: str) -> str | None:
    return lastIpByToken.get(token)


def banIp(ip: str, seconds: float) -> float:
    """IPを禁止する。戻り値は禁止期限。seconds<=0 で解除。"""
    now = time.time()
    if seconds <= 0:
        bannedIps.pop(ip, None)
        return 0.0
    until = now + max(1.0, seconds)
    bannedIps[ip] = until
    return until


def ipBanRemaining(ip: str) -> float:
    until = bannedIps.get(ip, 0.0)
    if until <= 0.0:
        return 0.0
    remain = until - time.time()
    if remain <= 0.0:
        bannedIps.pop(ip, None)
        return 0.0
    return remain


def newInventory() -> dict[str, int]:
    return dict.fromkeys(cfg.specialInks, 0)


def randomUserColor() -> str:
    # 見た目用であり秘密情報ではない
    return f"#{random.randint(0, 0xFFFFFF):06x}"  # noqa: S311


def genUid(used: set[str] | None = None) -> str:
    while True:
        uid = "".join(secrets.choice(UID_ALPHABET) for _ in range(6))
        if used is None or uid not in used:
            if used is not None:
                used.add(uid)
            return uid


def cleanName(raw: str, fallback: str = "ななし") -> str:
    name = (raw or "").strip().replace("\n", " ")[: cfg.maxNameLen].strip()
    return name or fallback


def normalizeLang(raw: str | None) -> str | None:
    """言語タグを作成者ロケールに正規化。対応外は None。"""
    if not raw:
        return None
    tag = raw.strip().lower().replace("_", "-")
    if "hant" in tag or tag.startswith("zh-tw") or tag in ("zh-hk", "zh-mo"):
        return "zh-TW"
    for prefix, lang in (("zh", "zh-CN"), ("ko", "ko"), ("en", "en"), ("ja", "ja")):
        if tag.startswith(prefix):
            return lang
    return None


def parseAcceptLanguage(header: str) -> str | None:
    """Accept-Language を q値順に走査し、最初の対応ロケールを返す。"""
    candidates: list[tuple[float, str]] = []
    for item in (header or "").split(","):
        chunks = item.split(";")
        tag = chunks[0].strip()
        if not tag:
            continue
        quality = 1.0
        for param in chunks[1:]:
            name, sep, value = param.strip().partition("=")
            if sep and name.strip().lower() == "q":
                try:
                    quality = max(0.0, min(1.0, float(value)))
                except ValueError:
                    quality = 0.0
        candidates.append((quality, tag))
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    for quality, tag in candidates:
        if quality <= 0.0:
            continue
        lang = normalizeLang(tag)
        if lang is not None:
            return lang
    return None


def defaultNameFor(explicit: str | None = None, header: str = "") -> str:
    """規定表示名。明示lang → Accept-Language → 日本語の順で決定。"""
    lang = normalizeLang(explicit) or parseAcceptLanguage(header) or "ja"
    return ANON_NAMES.get(lang, "ななし")


def cleanColor(raw: str, fallback: str) -> str:
    if isinstance(raw, str) and HEX_COLOR.match(raw):
        return raw.lower()
    if isinstance(fallback, str) and HEX_COLOR.match(fallback):
        return fallback.lower()
    return "#22aa66"


def clampLevel(level: int) -> int:
    """下限1のみ (上限なし)。"""
    try:
        return max(1, int(level))
    except (TypeError, ValueError):
        return 1


def cooldownForLevel(level: int) -> float:
    """下限への指数接近。序盤は速く、終盤は緩やか (Lv100でほぼ下限)。"""
    lv = clampLevel(level)
    gap = cfg.cooldownSec - cfg.minCooldown
    return max(cfg.minCooldown, cfg.minCooldown + gap * (cfg.cooldownDecay ** (lv - 1)))


def xpNeededForLevel(level: int) -> int:
    """序盤は上がりやすく、後半は上がりづらい2次曲線。"""
    lv = clampLevel(level)
    return max(1, int(cfg.xpBase * (lv**cfg.xpPow)))


def parseInventory(raw: str) -> dict[str, int]:
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    out = {}
    for k in cfg.specialInks:
        try:
            out[k] = max(0, int(data.get(k, 0)))
        except (TypeError, ValueError):
            out[k] = 0
    return out


def rowToUser(row: Sequence[Any]) -> dict:
    return {
        "token": row[0],
        "uid": row[1],
        "name": row[2],
        "color": row[3],
        "inventory": parseInventory(row[4]),
        "cooldownUntil": float(row[5] or 0.0),
        "level": clampLevel(row[6] or 1),
        "xp": max(0, int(row[7] or 0)),
        "transferCode": row[8],
        "hasAccount": bool(row[9]),
        "country": row[10],
        "showCountry": bool(row[11]),
    }


async def newUidDb(db: aiosqlite.Connection) -> str:
    while True:
        uid = "".join(secrets.choice(UID_ALPHABET) for _ in range(6))
        async with db.execute("SELECT 1 FROM users WHERE uid = ?", (uid,)) as cur:
            if await cur.fetchone() is None:
                return uid


async def newTransferCodeDb(db: aiosqlite.Connection) -> str:
    while True:
        code = "-".join("".join(secrets.choice(CODE_ALPHABET) for _ in range(4)) for _ in range(2))
        async with db.execute("SELECT 1 FROM users WHERE transferCode = ?", (code,)) as cur:
            if await cur.fetchone() is None:
                return code


async def fetchUser(db: aiosqlite.Connection, token: str) -> dict | None:
    async with db.execute(
        "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp,"
        " transferCode, passwordHash, country, showCountry FROM users WHERE token = ?",
        (token,),
    ) as cur:
        row = await cur.fetchone()
    return rowToUser(row) if row else None


@dataclass
class NewUser:
    token: str
    uid: str
    name: str = "ななし"
    color: str = "#22aa66"
    inventory: dict[str, int] = field(default_factory=dict)
    cooldownUntil: float = 0.0
    level: int = 1
    xp: int = 0
    country: str | None = None
    showCountry: bool = True


async def insertUser(db: aiosqlite.Connection, new: NewUser) -> dict:
    await db.execute(
        "INSERT INTO users(token, uid, name, color, inventory, cooldownUntil, level, xp,"
        " country, showCountry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            new.token,
            new.uid,
            new.name,
            new.color,
            json.dumps(new.inventory, ensure_ascii=False),
            new.cooldownUntil,
            new.level,
            new.xp,
            new.country,
            int(new.showCountry),
        ),
    )
    user = await fetchUser(db, new.token)
    assert user is not None  # noqa: S101 — 直前INSERTのため存在保証
    return user


async def ensureUser(db: aiosqlite.Connection, token: str, defaultName: str = "ななし") -> dict:
    user = await fetchUser(db, token)
    if user is not None:
        return user
    try:
        user = await insertUser(
            db,
            NewUser(
                token=token,
                uid=await newUidDb(db),
                name=defaultName,
                color=randomUserColor(),
                inventory=newInventory(),
            ),
        )
    except aiosqlite.IntegrityError:
        # 同時作成の競合 → 勝者の行を読む
        user = await fetchUser(db, token)
        assert user is not None  # noqa: S101 — 競合相手の行が存在するはず
    await db.commit()
    return user


def hashPassword(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
    return f"scrypt$16384$8$1${salt.hex()}${dk.hex()}"


def verifyPassword(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, saltHex, dkHex = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(saltHex),
            n=int(n),
            r=int(r),
            p=int(p),
        )
        return hmac.compare_digest(dk.hex(), dkHex)
    except Exception:
        return False


def checkRate(hits: dict[str, list[float]], key: str, limit: int, windowSec: float) -> bool:
    now = time.time()
    arr = [t for t in hits.get(key, []) if now - t < windowSec]
    if len(arr) >= limit:
        hits[key] = arr
        return False
    arr.append(now)
    hits[key] = arr
    return True


def parseClientIp(value: str | None) -> str | None:
    """単一IPとして正規化できれば返す (カンマ入り・不正値は拒否)。"""
    if not value:
        return None
    candidate = value.strip()
    if "," in candidate:
        return None
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def peerTrusted(peer: str) -> bool:
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    for raw in cfg.trustedProxies:
        try:
            if addr in ipaddress.ip_network(raw, strict=False):
                return True
        except ValueError:
            continue
    return False


def cleanCountryCode(raw: str | None) -> str | None:
    """CF-IPCountry用。国コード2字のみ採用 (XX/T1など不明は破棄)。"""
    if not raw:
        return None
    code = raw.strip().upper()
    if not COUNTRY_RE.match(code) or code in ("XX", "T1"):
        return None
    return code


def resolveClientIp(*, peer: str, cfConnectingIp: str = "", forwardedFor: str = "") -> str:
    """信頼プロキシ (trustedProxies) 経由のみヘッダを信用する。
    直結リクエストの CF-Connecting-IP / X-Forwarded-For は偽装可能なため無視する。
    """
    if peerTrusted(peer):
        single = parseClientIp(cfConnectingIp)
        if single is not None:
            return single
        if forwardedFor:
            first = parseClientIp(forwardedFor.split(",", 1)[0])
            if first is not None:
                return first
    return peer or "unknown"


# IANAタイムゾーン → 国コード (CF-IPCountryが無い場合の推定用。確信分のみ収録)
TZ_COUNTRY: dict[str, str] = {
    "Asia/Tokyo": "JP",
    "Asia/Seoul": "KR",
    "Asia/Shanghai": "CN",
    "Asia/Urumqi": "CN",
    "Asia/Harbin": "CN",
    "Asia/Chongqing": "CN",
    "Asia/Kashgar": "CN",
    "Asia/Taipei": "TW",
    "Asia/Hong_Kong": "HK",
    "Asia/Macau": "MO",
    "Asia/Singapore": "SG",
    "Asia/Bangkok": "TH",
    "Asia/Jakarta": "ID",
    "Asia/Makassar": "ID",
    "Asia/Jayapura": "ID",
    "Asia/Pontianak": "ID",
    "Asia/Manila": "PH",
    "Asia/Kuala_Lumpur": "MY",
    "Asia/Ho_Chi_Minh": "VN",
    "Asia/Hanoi": "VN",
    "Asia/Dhaka": "BD",
    "Asia/Kathmandu": "NP",
    "Asia/Colombo": "LK",
    "Asia/Karachi": "PK",
    "Asia/Kolkata": "IN",
    "Asia/Dubai": "AE",
    "Asia/Riyadh": "SA",
    "Asia/Qatar": "QA",
    "Asia/Kuwait": "KW",
    "Asia/Bahrain": "BH",
    "Asia/Muscat": "OM",
    "Asia/Tehran": "IR",
    "Asia/Baghdad": "IQ",
    "Asia/Amman": "JO",
    "Asia/Beirut": "LB",
    "Asia/Jerusalem": "IL",
    "Asia/Gaza": "PS",
    "Asia/Hebron": "PS",
    "Asia/Damascus": "SY",
    "Asia/Istanbul": "TR",
    "Asia/Baku": "AZ",
    "Asia/Tbilisi": "GE",
    "Asia/Yerevan": "AM",
    "Asia/Almaty": "KZ",
    "Asia/Tashkent": "UZ",
    "Asia/Bishkek": "KG",
    "Asia/Dushanbe": "TJ",
    "Asia/Ashgabat": "TM",
    "Asia/Ulaanbaatar": "MN",
    "Asia/Pyongyang": "KP",
    "Asia/Thimphu": "BT",
    "Asia/Yangon": "MM",
    "Asia/Vientiane": "LA",
    "Asia/Phnom_Penh": "KH",
    "Asia/Dili": "TL",
    "Asia/Brunei": "BN",
    "Asia/Samarkand": "UZ",
    "Asia/Qyzylorda": "KZ",
    "Asia/Aqtobe": "KZ",
    "Asia/Aqtau": "KZ",
    "Asia/Oral": "KZ",
    "Asia/Qostanay": "KZ",
    "Asia/Atyrau": "KZ",
    "Asia/Hovd": "MN",
    "Asia/Choibalsan": "MN",
    "Europe/London": "GB",
    "Europe/Paris": "FR",
    "Europe/Berlin": "DE",
    "Europe/Rome": "IT",
    "Europe/Madrid": "ES",
    "Europe/Lisbon": "PT",
    "Europe/Amsterdam": "NL",
    "Europe/Brussels": "BE",
    "Europe/Zurich": "CH",
    "Europe/Vienna": "AT",
    "Europe/Prague": "CZ",
    "Europe/Warsaw": "PL",
    "Europe/Budapest": "HU",
    "Europe/Bucharest": "RO",
    "Europe/Sofia": "BG",
    "Europe/Athens": "GR",
    "Europe/Helsinki": "FI",
    "Europe/Stockholm": "SE",
    "Europe/Oslo": "NO",
    "Europe/Copenhagen": "DK",
    "Europe/Dublin": "IE",
    "Europe/Moscow": "RU",
    "Europe/Kaliningrad": "RU",
    "Europe/Samara": "RU",
    "Europe/Volgograd": "RU",
    "Europe/Saratov": "RU",
    "Europe/Ulyanovsk": "RU",
    "Europe/Astrakhan": "RU",
    "Europe/Kirov": "RU",
    "Europe/Minsk": "BY",
    "Europe/Kyiv": "UA",
    "Europe/Chisinau": "MD",
    "Europe/Riga": "LV",
    "Europe/Vilnius": "LT",
    "Europe/Tallinn": "EE",
    "Europe/Belgrade": "RS",
    "Europe/Zagreb": "HR",
    "Europe/Sarajevo": "BA",
    "Europe/Skopje": "MK",
    "Europe/Tirana": "AL",
    "Europe/Podgorica": "ME",
    "Europe/Ljubljana": "SI",
    "Europe/Bratislava": "SK",
    "Europe/Luxembourg": "LU",
    "Europe/Monaco": "MC",
    "Europe/Andorra": "AD",
    "Europe/Malta": "MT",
    "Europe/Nicosia": "CY",
    "Europe/Reykjavik": "IS",
    "Europe/Mariehamn": "FI",
    "Europe/Gibraltar": "GI",
    "Europe/Vatican": "VA",
    "Europe/San_Marino": "SM",
    "Europe/Vaduz": "LI",
    "Atlantic/Azores": "PT",
    "Atlantic/Madeira": "PT",
    "Atlantic/Canary": "ES",
    "Atlantic/Faroe": "DK",
    "Atlantic/Reykjavik": "IS",
    "Asia/Yekaterinburg": "RU",
    "Asia/Novosibirsk": "RU",
    "Asia/Krasnoyarsk": "RU",
    "Asia/Irkutsk": "RU",
    "Asia/Yakutsk": "RU",
    "Asia/Vladivostok": "RU",
    "Asia/Magadan": "RU",
    "Asia/Kamchatka": "RU",
    "Asia/Sakhalin": "RU",
    "Asia/Anadyr": "RU",
    "Asia/Srednekolymsk": "RU",
    "Asia/Chita": "RU",
    "Asia/Khandyga": "RU",
    "Asia/Ust-Nera": "RU",
    "Asia/Omsk": "RU",
    "Asia/Tomsk": "RU",
    "Asia/Barnaul": "RU",
    "Asia/Novokuznetsk": "RU",
    "Africa/Cairo": "EG",
    "Africa/Lagos": "NG",
    "Africa/Johannesburg": "ZA",
    "Africa/Nairobi": "KE",
    "Africa/Addis_Ababa": "ET",
    "Africa/Khartoum": "SD",
    "Africa/Tunis": "TN",
    "Africa/Algiers": "DZ",
    "Africa/Casablanca": "MA",
    "Africa/Accra": "GH",
    "Africa/Dakar": "SN",
    "Africa/Abidjan": "CI",
    "Africa/Kinshasa": "CD",
    "Africa/Lubumbashi": "CD",
    "Africa/Douala": "CM",
    "Africa/Luanda": "AO",
    "Africa/Dar_es_Salaam": "TZ",
    "Africa/Kampala": "UG",
    "Africa/Kigali": "RW",
    "Africa/Maputo": "MZ",
    "Africa/Windhoek": "NA",
    "Africa/Gaborone": "BW",
    "Africa/Harare": "ZW",
    "Africa/Lusaka": "ZM",
    "Africa/Blantyre": "MW",
    "Africa/Tripoli": "LY",
    "Africa/Ndjamena": "TD",
    "Africa/Niamey": "NE",
    "Africa/Bamako": "ML",
    "Africa/Ouagadougou": "BF",
    "Africa/Conakry": "GN",
    "Africa/Freetown": "SL",
    "Africa/Monrovia": "LR",
    "Africa/Banjul": "GM",
    "Africa/Bissau": "GW",
    "Africa/Nouakchott": "MR",
    "Africa/Djibouti": "DJ",
    "Africa/Mogadishu": "SO",
    "Africa/Asmara": "ER",
    "Africa/Juba": "SS",
    "Africa/Bangui": "CF",
    "Africa/Brazzaville": "CG",
    "Africa/Libreville": "GA",
    "Africa/Malabo": "GQ",
    "Africa/Sao_Tome": "ST",
    "Africa/Porto-Novo": "BJ",
    "Africa/Lome": "TG",
    "Africa/El_Aaiun": "EH",
    "Africa/Maseru": "LS",
    "Africa/Mbabane": "SZ",
    "Africa/Bujumbura": "BI",
    "Africa/Moroni": "KM",
    "Africa/Antananarivo": "MG",
    "Africa/Mahe": "SC",
    "Africa/Reunion": "RE",
    "Africa/Mayotte": "YT",
    "America/New_York": "US",
    "America/Chicago": "US",
    "America/Denver": "US",
    "America/Los_Angeles": "US",
    "America/Anchorage": "US",
    "America/Detroit": "US",
    "America/Boise": "US",
    "America/Phoenix": "US",
    "America/Juneau": "US",
    "America/Sitka": "US",
    "America/Metlakatla": "US",
    "America/Yakutat": "US",
    "America/Nome": "US",
    "America/Adak": "US",
    "America/Indiana/Indianapolis": "US",
    "America/Indiana/Knox": "US",
    "America/Indiana/Marengo": "US",
    "America/Indiana/Petersburg": "US",
    "America/Indiana/Tell_City": "US",
    "America/Indiana/Vevay": "US",
    "America/Indiana/Vincennes": "US",
    "America/Indiana/Winamac": "US",
    "America/Kentucky/Louisville": "US",
    "America/Kentucky/Monticello": "US",
    "America/North_Dakota/Beulah": "US",
    "America/North_Dakota/Center": "US",
    "America/North_Dakota/New_Salem": "US",
    "Pacific/Honolulu": "US",
    "America/Toronto": "CA",
    "America/Vancouver": "CA",
    "America/St_Johns": "CA",
    "America/Halifax": "CA",
    "America/Winnipeg": "CA",
    "America/Edmonton": "CA",
    "America/Regina": "CA",
    "America/Dawson_Creek": "CA",
    "America/Fort_Nelson": "CA",
    "America/Creston": "CA",
    "America/Whitehorse": "CA",
    "America/Dawson": "CA",
    "America/Atikokan": "CA",
    "America/Rankin_Inlet": "CA",
    "America/Resolute": "CA",
    "America/Cambridge_Bay": "CA",
    "America/Yellowknife": "CA",
    "America/Inuvik": "CA",
    "America/Goose_Bay": "CA",
    "America/Moncton": "CA",
    "America/Glace_Bay": "CA",
    "America/Blanc-Sablon": "CA",
    "America/Mexico_City": "MX",
    "America/Guatemala": "GT",
    "America/Belize": "BZ",
    "America/Tegucigalpa": "HN",
    "America/Managua": "NI",
    "America/Costa_Rica": "CR",
    "America/Panama": "PA",
    "America/Havana": "CU",
    "America/Jamaica": "JM",
    "America/Santo_Domingo": "DO",
    "America/Puerto_Rico": "PR",
    "America/Nassau": "BS",
    "America/Port-au-Prince": "HT",
    "America/Grand_Turk": "TC",
    "America/Cayman": "KY",
    "America/Curacao": "CW",
    "America/Aruba": "AW",
    "America/La_Paz": "BO",
    "America/Santiago": "CL",
    "America/Bogota": "CO",
    "America/Guayaquil": "EC",
    "America/Asuncion": "PY",
    "America/Lima": "PE",
    "America/Caracas": "VE",
    "America/Guyana": "GY",
    "America/Paramaribo": "SR",
    "America/Cayenne": "GF",
    "America/Montevideo": "UY",
    "America/Buenos_Aires": "AR",
    "America/Sao_Paulo": "BR",
    "America/Manaus": "BR",
    "America/Belem": "BR",
    "America/Fortaleza": "BR",
    "America/Recife": "BR",
    "America/Bahia": "BR",
    "America/Noronha": "BR",
    "America/Campo_Grande": "BR",
    "America/Cuiaba": "BR",
    "America/Santarem": "BR",
    "America/Porto_Velho": "BR",
    "America/Boa_Vista": "BR",
    "America/Rio_Branco": "BR",
    "America/Argentina/Buenos_Aires": "AR",
    "America/Argentina/Catamarca": "AR",
    "America/Argentina/Cordoba": "AR",
    "America/Argentina/Jujuy": "AR",
    "America/Argentina/La_Rioja": "AR",
    "America/Argentina/Mendoza": "AR",
    "America/Argentina/Rio_Gallegos": "AR",
    "America/Argentina/Salta": "AR",
    "America/Argentina/San_Juan": "AR",
    "America/Argentina/San_Luis": "AR",
    "America/Argentina/Tucuman": "AR",
    "America/Argentina/Ushuaia": "AR",
    "Pacific/Auckland": "NZ",
    "Pacific/Chatham": "NZ",
    "Australia/Sydney": "AU",
    "Australia/Melbourne": "AU",
    "Australia/Brisbane": "AU",
    "Australia/Perth": "AU",
    "Australia/Adelaide": "AU",
    "Australia/Darwin": "AU",
    "Australia/Hobart": "AU",
    "Australia/Lord_Howe": "AU",
    "Australia/Eucla": "AU",
    "Australia/Broken_Hill": "AU",
    "Pacific/Port_Moresby": "PG",
    "Pacific/Guadalcanal": "SB",
    "Pacific/Noumea": "NC",
    "Pacific/Suva": "FJ",
    "Pacific/Tongatapu": "TO",
    "Pacific/Apia": "WS",
    "Pacific/Tarawa": "KI",
    "Pacific/Kiritimati": "KI",
    "Pacific/Enderbury": "KI",
    "Pacific/Fakaofo": "TK",
    "Pacific/Majuro": "MH",
    "Pacific/Kwajalein": "MH",
    "Pacific/Nauru": "NR",
    "Pacific/Funafuti": "TV",
    "Pacific/Efate": "VU",
    "Pacific/Niue": "NU",
    "Pacific/Rarotonga": "CK",
    "Pacific/Pago_Pago": "AS",
    "Pacific/Tahiti": "PF",
    "Pacific/Marquesas": "PF",
    "Pacific/Gambier": "PF",
    "Pacific/Pitcairn": "PN",
    "Pacific/Easter": "CL",
}


def countryFromTimezone(raw: str | None) -> str | None:
    """端末タイムゾーンからの国推定。CF-IPCountryが無い場合の代替 (直結・無効時用)。"""
    if not raw or not isinstance(raw, str):
        return None
    return TZ_COUNTRY.get(raw.strip()[:64])


def requestCountry(peer: str, cfHeader: str | None, tz: str | None = None) -> str | None:
    """国の決定。CF-IPCountry優先 (信頼経由のみ。直結の値は偽装可能なため破棄)。

    CFヘッダーが無い・無効な場合は端末タイムゾーンから推定する。
    なお CF-IPCountry 自体はダッシュボードで IP Geolocation (または
    Add visitor location headers) を有効にしないと送られてこない。
    """
    if peerTrusted(peer):
        code = cleanCountryCode(cfHeader)
        if code is not None:
            return code
    return countryFromTimezone(tz)
