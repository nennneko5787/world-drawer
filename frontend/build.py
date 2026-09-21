#!/usr/bin/env python3
"""Pages静的ビルド (stdlibのみ)。

- pages/*.html を5言語分プリレンダ (OGP meta + <html lang> + <title>)
- /static/ URLに ?v=<content-hash> 付与、wd-wsonly=1固定
- static/sw.js → dist/sw.js (版注入・scope=/用)。static/manifest.json →
  dist/manifest.json (アイコンURLに?v=版付与)。static/img/favicon.ico +
  apple-touch-icon.png → dist直下にも配置 (PWA)
- <meta name=wd-api/wd-ws/wd-turnstile-site> 注入 (env WD_API/WD_WS/TURNSTILE_SITE_KEY)
- static/ をそのままコピー (sw.js・manifest.json除く) + _headers 生成 (Pages用キャッシュ規則)

使い方:
  WD_API=https://api.example.com WD_WS=wss://api.example.com/ws python frontend/build.py
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PAGES = BASE / "pages"
STATIC = BASE / "static"
DIST = BASE / "dist"

LANGS = ("ja", "en", "ko", "zh-CN", "zh-TW")
OG_LOCALE = {"ja": "ja_JP", "en": "en_US", "ko": "ko_KR", "zh-CN": "zh_CN", "zh-TW": "zh_TW"}
SITE = "pixDraw"

OG_TEXTS = {
    "index": {
        "ja": (
            "pixDraw - みんなでキャンバスに描こう！",
            "pixDrawは誰でも自由に描ける、共同制作のオンライン・リアルタイムピクセルキャンバスです。キャンバスにたくさんのピクセルアートを描こう！",
        ),
        "en": (
            "pixDraw - Let's paint canvas!",
            "pixDraw is collaborative, an online real-time pixel canvas where anyone can draw freely. Let's draw many pixel arts on canvas!",
        ),
        "ko": (
            "pixDraw - 캔버스에 그려봐요!",
            "pixDraw는 누구나 자유롭게 그릴 수 있는 협업 온라인 실시간 픽셀 캔버스입니다. 캔버스에 멋진 픽셀 아트를 많이 그려봐요!",
        ),
        "zh-CN": (
            "pixDraw - 来画布上作画吧！",
            "pixDraw 是任何人都可以自由绘制的协作型在线实时像素画布。来画布上绘制许多像素画吧！",
        ),
        "zh-TW": (
            "pixDraw - 來畫布上作畫吧！",
            "pixDraw 是任何人都可以自由繪製的協作型線上即時像素畫布。來畫布上繪製許多像素畫吧！",
        ),
    },
    "help": {
        "ja": (
            "ヘルプ - pixDraw",
            "pixDraw の遊び方。基本操作・インク・レベルとクールダウン・設計図・履歴・アカウント引っ越し・荒らし対策・ルールを解説。",
        ),
        "en": (
            "Help - pixDraw",
            "How to play pixDraw: basics, inks, levels and cooldowns, blueprints, history, account transfer, anti-grief measures, and rules.",
        ),
        "ko": (
            "도움말 - pixDraw",
            "pixDraw 플레이 방법: 기본 조작·잉크·레벨과 쿨다운·설계도·기록·계정 이전·어뷰징 대책·규칙 안내.",
        ),
        "zh-CN": (
            "帮助 - pixDraw",
            "pixDraw 玩法说明：基本操作、墨水、等级与冷却、设计图、历史、账号迁移、防破坏措施、规则。",
        ),
        "zh-TW": (
            "說明 - pixDraw",
            "pixDraw 玩法說明：基本操作、墨水、等級與冷卻、設計圖、歷史、帳號遷移、防破壞措施、規則。",
        ),
    },
    "notices": {
        "ja": (
            "お知らせ - pixDraw",
            "pixDraw のお知らせ一覧。運営からの案内を掲載します。",
        ),
        "en": (
            "Notices - pixDraw",
            "pixDraw notices: announcements from the operators.",
        ),
        "ko": (
            "공지 - pixDraw",
            "pixDraw 공지 목록. 운영팀의 안내를 게시합니다.",
        ),
        "zh-CN": (
            "公告 - pixDraw",
            "pixDraw 公告列表。发布来自运营团队的通知。",
        ),
        "zh-TW": (
            "公告 - pixDraw",
            "pixDraw 公告列表。發佈來自營運團隊的通知。",
        ),
    },
    "admin": {
        "ja": ("管理 - pixDraw", "管理者用の操作ページ。"),
        "en": ("Admin - pixDraw", "Admin operations page."),
        "ko": ("관리 - pixDraw", "관리자용 작업 페이지."),
        "zh-CN": ("管理 - pixDraw", "管理员操作页面。"),
        "zh-TW": ("管理 - pixDraw", "管理員操作頁面。"),
    },
}

STATIC_RE = re.compile(r"""(["'])/static/([^"'?#\s]*)""")
HTML_LANG_RE = re.compile(r'<html(\s[^>]*)?\blang="[^"]*"', re.IGNORECASE)
TITLE_RE = re.compile(r"(<title[^>]*>).*?(</title>)", re.IGNORECASE | re.DOTALL)


def asset_version() -> str:
    h = hashlib.sha256()
    for p in sorted(STATIC.rglob("*")):
        if p.is_file():
            st = p.stat()
            h.update(f"{p.relative_to(STATIC)}:{st.st_mtime_ns}:{st.st_size}".encode())
    return h.hexdigest()[:12]


def build_tags(*, lang: str, page: str, base: str, path: str, img_base: str) -> str:
    title, desc = OG_TEXTS[page][lang]
    esc = html.escape
    # og:imageはAPI側の動的レンダ (/og-image.png) を指す。別ドメインで問題ない
    # (クローラが素直GETするためCORSは無関係)。og:urlはサイト側のまま。
    img = img_base.rstrip("/") + "/og-image.png"
    lines = [
        f'<meta name="description" content="{esc(desc, quote=True)}">',
        f'<link rel="canonical" href="{esc(base + path, quote=True)}">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{esc(SITE, quote=True)}">',
        f'<meta property="og:title" content="{esc(title, quote=True)}">',
        f'<meta property="og:description" content="{esc(desc, quote=True)}">',
        f'<meta property="og:url" content="{esc(base + path, quote=True)}">',
        f'<meta property="og:image" content="{esc(img, quote=True)}">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:image:type" content="image/png">',
        f'<meta property="og:image:alt" content="{esc(SITE, quote=True)}">',
        f'<meta property="og:locale" content="{OG_LOCALE[lang]}">',
    ]
    lines += [
        f'<meta property="og:locale:alternate" content="{OG_LOCALE[o]}">'
        for o in LANGS
        if o != lang
    ]
    lines += [
        '<meta name="twitter:card" content="summary_large_image">',
        f'<meta name="twitter:title" content="{esc(title, quote=True)}">',
        f'<meta name="twitter:description" content="{esc(desc, quote=True)}">',
        f'<meta name="twitter:image" content="{esc(img, quote=True)}">',
        '<meta name="theme-color" content="#ffffff">',
    ]
    return "\n    ".join(lines)


def render_page(
    name: str, page: str, lang: str, ver: str, base: str, api: str, ws: str, sitekey: str,
    prev_origins: str = "",
) -> str:
    raw = (PAGES / name).read_text(encoding="utf-8")
    title, _ = OG_TEXTS[page][lang]
    tags = build_tags(
        lang=lang, page=page, base=base, path="/" + page if page != "index" else "/", img_base=api
    )
    out = HTML_LANG_RE.sub(f'<html\\1lang="{lang}"', raw, count=1)
    out = TITLE_RE.sub(lambda m: f"{m.group(1)}{html.escape(title)}{m.group(2)}", out, count=1)
    if "<!-- OGP-START -->" in out and "<!-- OGP-END -->" in out:
        head, rest = out.split("<!-- OGP-START -->", 1)
        _, tail = rest.split("<!-- OGP-END -->", 1)
        out = f"{head}<!-- OGP-START -->\n    {tags}\n    <!-- OGP-END -->{tail}"
    out = STATIC_RE.sub(rf"\1/static/\2?v={ver}", out)
    out = out.replace('name="wd-wsonly" content="0"', 'name="wd-wsonly" content="1"')
    # API/WS/Turnstile/移行元注入 (head末尾)
    inject = (
        f'\n    <meta name="wd-api" content="{html.escape(api, quote=True)}">'
        f'\n    <meta name="wd-ws" content="{html.escape(ws, quote=True)}">'
        f'\n    <meta name="wd-turnstile-site" content="{html.escape(sitekey, quote=True)}">'
        f'\n    <meta name="wd-prev-origins" content="{html.escape(prev_origins, quote=True)}">'
        f'\n    <meta name="wd-ver" content="{html.escape(ver, quote=True)}">'
    )
    if sitekey:
        inject += (
            '\n    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"'
            " async defer></script>"
        )
    out = out.replace("</head>", f"{inject}\n</head>", 1)
    return out


def _strip_jsonc(text: str) -> str:
    out: list[str] = []
    i, n = 0, len(text)
    in_str, esc = False, False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] in ("/", "*"):
            if text[i + 1] == "/":
                while i < n and text[i] != "\n":
                    i += 1
            else:
                i += 2
                while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                    i += 1
                i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def load_config() -> dict:
    """config.jsonc + config.local.jsonc (後勝ち)。壊れてたら空扱い。"""
    import json

    merged: dict = {}
    for name in ("config.jsonc", "config.local.jsonc"):
        p = BASE / name
        try:
            text = _strip_jsonc(p.read_text(encoding="utf-8-sig"))
            # 末尾カンマ除去 (JSONC許容)
            text = re.sub(r",(\s*[}\]])", r"\1", text)
            raw = json.loads(text)
        except (OSError, ValueError):
            continue
        if isinstance(raw, dict):
            merged.update(raw)
    return merged


def emit_pwa_root_files(ver: str) -> None:
    """PWA用ファイルをdist直下へ (manifest・SW・favicon・apple-touch-icon)。

    SWは __WD_SW_VERSION__ に版を注入 (キャッシュ名の切替用)。
    manifestの /static/ アイコンURLには ?v=版 を付与
    (immutable長期キャッシュとの不整合防止)。
    scopeの都合でdist直下が正本。/static/sw.js・/static/manifest.jsonは置かない。
    """
    manifest_src = STATIC / "manifest.json"
    if manifest_src.is_file():
        manifest = json.loads(manifest_src.read_text(encoding="utf-8"))
        targets = list(manifest.get("icons", []))
        for shortcut in manifest.get("shortcuts", []):
            targets += shortcut.get("icons", [])
        for icon in targets:
            src = icon.get("src", "")
            if src.startswith("/static/") and "?v=" not in src:
                icon["src"] = f"{src}?v={ver}"
        (DIST / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    sw_src = STATIC / "sw.js"
    if sw_src.is_file():
        sw_body = sw_src.read_text(encoding="utf-8").replace("__WD_SW_VERSION__", ver)
        (DIST / "sw.js").write_text(sw_body, encoding="utf-8")
    for img_name in ("favicon.ico", "apple-touch-icon.png"):
        img_src = STATIC / "img" / img_name
        if img_src.is_file():
            shutil.copyfile(img_src, DIST / img_name)


def main() -> int:
    cfg = load_config()
    ts_cfg = cfg.get("turnstile") if isinstance(cfg.get("turnstile"), dict) else {}
    base = (os.environ.get("WD_BASE") or cfg.get("siteUrl") or "https://example.com").rstrip("/")
    api = os.environ.get("WD_API") or cfg.get("apiBase") or "https://api.example.com"
    ws = os.environ.get("WD_WS") or cfg.get("wsUrl") or "wss://api.example.com/ws"
    sitekey = os.environ.get("TURNSTILE_SITE_KEY") or ts_cfg.get("siteKey", "")
    raw_prev = cfg.get("previousOrigins") or []
    prev_list = [str(o).strip().rstrip("/") for o in raw_prev if str(o).strip()]
    prev_origins = ",".join(prev_list)
    ver = asset_version()

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "static").mkdir(parents=True)
    # static copy (sw.js・manifest.jsonはscope/版付与の都合でdist直下へ。
    # /static/sw.js・/static/manifest.jsonは置かない)
    for p in STATIC.rglob("*"):
        if p.is_file() and p.name not in ("sw.js", "manifest.json"):
            rel = p.relative_to(STATIC)
            dst = DIST / "static" / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dst)

    # PWA: manifest・SW・favicon・apple-touch-iconをdist直下へ
    emit_pwa_root_files(ver)

    specs = [
        ("index.html", "index", "/"),
        ("help.html", "help", "/help"),
        ("notices.html", "notices", "/notices"),
        ("admin.html", "admin", "/admin"),
    ]
    for name, page, path in specs:
        # 既定言語 (Accept-Languageなしのクローラ向け) は英語をそのまま配置
        for lang in LANGS:
            body = render_page(name, page, lang, ver, base, api, ws, sitekey, prev_origins)
            if lang == "en":
                (DIST / name).write_text(body, encoding="utf-8")
            d = DIST / lang / ("" if page == "index" else page)
            if page == "index":
                (DIST / lang).mkdir(parents=True, exist_ok=True)
                (DIST / lang / "index.html").write_text(body, encoding="utf-8")
            else:
                d.mkdir(parents=True, exist_ok=True)
                (d / "index.html").write_text(body, encoding="utf-8")

    # 移行shim: 旧ドメイン側に配置する単体ファイル。許可親オリジンは
    # このサイト自身 (base) のみ (postMessageの宛先詐称対策)。
    mig_raw = (PAGES / "migrate.html").read_text(encoding="utf-8")
    mig_allow = html.escape(json.dumps([base]), quote=True)
    (DIST / "migrate.html").write_text(
        mig_raw.replace("<!--WD_MIGRATE_ALLOW-->", mig_allow), encoding="utf-8"
    )

    headers = """\
/static/*
  Cache-Control: public, max-age=31536000, immutable
/sw.js
  Cache-Control: no-cache
/manifest.json
  Cache-Control: public, max-age=300
/apple-touch-icon.png
  Cache-Control: public, max-age=86400
/favicon.ico
  Cache-Control: public, max-age=86400
/*.html
  Cache-Control: public, max-age=300
/
  Cache-Control: public, max-age=300
/admin
  Cache-Control: no-store
/notices
  Cache-Control: public, max-age=300
"""
    (DIST / "_headers").write_text(headers, encoding="utf-8")
    print(f"built dist/ ver={ver} base={base} api={api}")
    for label, val in (("siteUrl", base), ("apiBase", api), ("wsUrl", ws)):
        if "example.com" in val:
            print(
                f"WARN: {label}が既定値のまま ({val})。"
                " config.local.jsonc か環境変数で設定してください",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
