"""OGP (Open Graph) の言語別出し分け。

クローラは JS を実行しないため、クライアント側 i18n.js だけでは OGP を
切り替えられない。`?lang=` → `Accept-Language` の順で言語を決め、
サーバー側で meta タグを注入する。
"""

from __future__ import annotations

import html
import re

from app.services import users

SUPPORTED_LANGS: tuple[str, ...] = ("ja", "en", "ko", "zh-CN", "zh-TW")

OG_LOCALE: dict[str, str] = {
    "ja": "ja_JP",
    "en": "en_US",
    "ko": "ko_KR",
    "zh-CN": "zh_CN",
    "zh-TW": "zh_TW",
}

SITE_NAME = "The world drawer"

# ページと言語の組み合わせごとの (title, description)。クローラ・SEO用の短文に留める。
OG_TEXTS: dict[str, dict[str, tuple[str, str]]] = {
    "index": {
        "ja": (
            "The world drawer - みんなでキャンバスに描こう！",
            "The world drawerは誰でも自由に描ける、共同制作のオンライン・"
            "リアルタイムピクセルキャンバスです。キャンバスにたくさんの"
            "ピクセルアートを描こう！",
        ),
        "en": (
            "The world drawer - Let's paint canvas!",
            "The world drawer is collaborative, an online real-time pixel canvas "
            "where anyone can draw freely. Let's draw many pixel arts on canvas!",
        ),
        "ko": (
            "The world drawer - 캔버스에 그려봐요!",
            "The world drawer는 누구나 자유롭게 그릴 수 있는 협업 온라인 실시간 "
            "픽셀 캔버스입니다. 캔버스에 멋진 픽셀 아트를 많이 그려봐요!",
        ),
        "zh-CN": (
            "The world drawer - 来画布上作画吧！",
            "The world drawer 是任何人都可以自由绘制的协作型在线实时像素画布。"  # noqa: RUF001
            "来画布上绘制许多像素画吧！",
        ),
        "zh-TW": (
            "The world drawer - 來畫布上作畫吧！",
            "The world drawer 是任何人都可以自由繪製的協作型線上即時像素畫布。"  # noqa: RUF001
            "來畫布上繪製許多像素畫吧！",
        ),
    },
    "help": {
        "ja": (
            "ヘルプ - The world drawer",
            "The world drawer の遊び方。基本操作・インク・レベルとクールダウン・"
            "設計図・履歴・アカウント引っ越し・荒らし対策・ルールを解説。",
        ),
        "en": (
            "Help - The world drawer",
            "How to play The world drawer: basics, inks, levels and cooldowns, "
            "blueprints, history, account transfer, anti-grief measures, and rules.",
        ),
        "ko": (
            "도움말 - The world drawer",
            "The world drawer 플레이 방법: 기본 조작·잉크·레벨과 쿨다운·설계도·"
            "기록·계정 이전·어뷰징 대책·규칙 안내.",
        ),
        "zh-CN": (
            "帮助 - The world drawer",
            "The world drawer 玩法说明：基本操作、墨水、等级与冷却、设计图、"  # noqa: RUF001
            "历史、账号迁移、防破坏措施、规则。",
        ),
        "zh-TW": (
            "說明 - The world drawer",
            "The world drawer 玩法說明：基本操作、墨水、等級與冷卻、設計圖、"  # noqa: RUF001
            "歷史、帳號遷移、防破壞措施、規則。",
        ),
    },
    "admin": {
        "ja": ("管理 - The world drawer", "管理者用の操作ページ。"),
        "en": ("Admin - The world drawer", "Admin operations page."),
        "ko": ("관리 - The world drawer", "관리자용 작업 페이지."),
        "zh-CN": ("管理 - The world drawer", "管理员操作页面。"),
        "zh-TW": ("管理 - The world drawer", "管理員操作頁面。"),
    },
}

OGP_START = "<!-- OGP-START -->"
OGP_END = "<!-- OGP-END -->"
_HTML_LANG_RE = re.compile(r'<html(\s[^>]*)?\blang="[^"]*"', re.IGNORECASE)
_TITLE_RE = re.compile(r"(<title[^>]*>).*?(</title>)", re.IGNORECASE | re.DOTALL)


def resolveLang(explicit: str | None, header: str = "") -> str:
    """`?lang=` → `Accept-Language` → 英語の順で OGP 言語を決める。"""
    lang = users.normalizeLang(explicit) or users.parseAcceptLanguage(header or "")
    return lang if lang in SUPPORTED_LANGS else "en"


def pageText(page: str, lang: str) -> tuple[str, str]:
    table = OG_TEXTS.get(page, OG_TEXTS["index"])
    return table.get(lang, table["en"])


def buildTags(
    *, lang: str, page: str, baseUrl: str, path: str, queryLang: str | None = None
) -> str:
    """head 内に置く OGP/meta タグ列を組み立てる (絶対URL)。"""
    title, desc = pageText(page, lang)
    pageUrl = f"{baseUrl}{path}"
    if queryLang:
        pageUrl += f"?lang={queryLang}"
    imageUrl = f"{baseUrl}/og-image.png"
    esc = html.escape
    lines = [
        f'<meta name="description" content="{esc(desc, quote=True)}">',
        f'<link rel="canonical" href="{esc(pageUrl, quote=True)}">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{esc(SITE_NAME, quote=True)}">',
        f'<meta property="og:title" content="{esc(title, quote=True)}">',
        f'<meta property="og:description" content="{esc(desc, quote=True)}">',
        f'<meta property="og:url" content="{esc(pageUrl, quote=True)}">',
        f'<meta property="og:image" content="{esc(imageUrl, quote=True)}">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:image:type" content="image/png">',
        f'<meta property="og:image:alt" content="{esc(SITE_NAME, quote=True)}">',
        f'<meta property="og:locale" content="{OG_LOCALE[lang]}">',
    ]
    lines += [
        f'<meta property="og:locale:alternate" content="{OG_LOCALE[other]}">'
        for other in SUPPORTED_LANGS
        if other != lang
    ]
    lines += [
        '<meta name="twitter:card" content="summary_large_image">',
        f'<meta name="twitter:title" content="{esc(title, quote=True)}">',
        f'<meta name="twitter:description" content="{esc(desc, quote=True)}">',
        f'<meta name="twitter:image" content="{esc(imageUrl, quote=True)}">',
        '<meta name="theme-color" content="#ffffff">',
    ]
    return "\n    ".join(lines)


def localizeHtml(  # noqa: PLR0913 — 命名付き引数6つの純粋関数。束ねると読みづらいため許容
    raw: str,
    *,
    lang: str,
    page: str,
    baseUrl: str,
    path: str,
    queryLang: str | None = None,
) -> str:
    """静的 HTML に言語別の lang 属性・title・OGP タグを注入する。"""
    title, _desc = pageText(page, lang)
    tags = buildTags(lang=lang, page=page, baseUrl=baseUrl, path=path, queryLang=queryLang)
    out = _HTML_LANG_RE.sub(f'<html\\1lang="{lang}"', raw, count=1)
    out = _TITLE_RE.sub(lambda m: f"{m.group(1)}{html.escape(title)}{m.group(2)}", out, count=1)
    if OGP_START in out and OGP_END in out:
        head, rest = out.split(OGP_START, 1)
        _old, tail = rest.split(OGP_END, 1)
        out = f"{head}{OGP_START}\n    {tags}\n    {OGP_END}{tail}"
    else:
        out = out.replace("</head>", f"    {tags}\n</head>", 1)
    return out
