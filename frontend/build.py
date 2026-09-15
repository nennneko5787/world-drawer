#!/usr/bin/env python3
"""Pages静的ビルド (stdlibのみ)。

- pages/*.html を5言語分プリレンダ (OGP meta + <html lang> + <title>)
- /static/ URLに ?v=<content-hash> 付与、wd-wsonly=1固定
- <meta name=wd-api/wd-ws/wd-turnstile-site> 注入 (env WD_API/WD_WS/TURNSTILE_SITE_KEY)
- static/ をそのままコピー + _headers 生成 (Pages用キャッシュ規則)

使い方:
  WD_API=https://api.example.com WD_WS=wss://api.example.com/ws python frontend/build.py
"""

from __future__ import annotations

import hashlib
import html
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
SITE = "The world drawer"

OG_TEXTS = {
    "index": {
        "ja": ("The world drawer | みんなで描く無限キャンバス",
               "ブラウザで遊べる無限キャンバスのお絵かきボード。全員で1つの世界に1マスずつ描き、リアルタイムに同期。クールダウン・レベル・特殊インクつき。"),
        "en": ("The world drawer | An infinite canvas for everyone",
               "A browser-based infinite pixel canvas. Everyone paints one cell at a time into a single shared world, synced in real time."),
        "ko": ("The world drawer | 함께 그리는 무한 캔버스",
               "브라우저에서 즐기는 무한 캔버스 드로잉 보드. 모두가 하나의 세계에 한 칸씩 그리며 실시간으로 동기화됩니다."),
        "zh-CN": ("The world drawer | 共同绘制的无限画布",
                 "可在浏览器中游玩的无限画布绘画板。所有人在同一个世界中一次绘制一格，实时同步。"),
        "zh-TW": ("The world drawer | 共同繪製的無限畫布",
                 "可在瀏覽器中遊玩的無限畫布繪畫板。所有人在同一個世界中一次繪製一格，即時同步。"),
    },
    "help": {
        "ja": ("ヘルプ - The world drawer", "The world drawer の遊び方。基本操作・インク・レベルとクールダウン・設計図・履歴・アカウント引っ越し・荒らし対策・ルールを解説。"),
        "en": ("Help - The world drawer", "How to play The world drawer: basics, inks, levels and cooldowns, blueprints, history, account transfer, anti-grief measures, and rules."),
        "ko": ("도움말 - The world drawer", "The world drawer 플레이 방법: 기본 조작·잉크·레벨과 쿨다운·설계도·기록·계정 이전·어뷰징 대책·규칙 안내."),
        "zh-CN": ("帮助 - The world drawer", "The world drawer 玩法说明：基本操作、墨水、等级与冷却、设计图、历史、账号迁移、防破坏措施、规则。"),
        "zh-TW": ("說明 - The world drawer", "The world drawer 玩法說明：基本操作、墨水、等級與冷卻、設計圖、歷史、帳號遷移、防破壞措施、規則。"),
    },
    "admin": {
        "ja": ("管理 - The world drawer", "管理者用の操作ページ。"),
        "en": ("Admin - The world drawer", "Admin operations page."),
        "ko": ("관리 - The world drawer", "관리자용 작업 페이지."),
        "zh-CN": ("管理 - The world drawer", "管理员操作页面。"),
        "zh-TW": ("管理 - The world drawer", "管理員操作頁面。"),
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


def build_tags(*, lang: str, page: str, base: str, path: str) -> str:
    title, desc = OG_TEXTS[page][lang]
    esc = html.escape
    lines = [
        f'<meta name="description" content="{esc(desc, quote=True)}">',
        f'<link rel="canonical" href="{esc(base + path, quote=True)}">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{esc(SITE, quote=True)}">',
        f'<meta property="og:title" content="{esc(title, quote=True)}">',
        f'<meta property="og:description" content="{esc(desc, quote=True)}">',
        f'<meta property="og:url" content="{esc(base + path, quote=True)}">',
        f'<meta property="og:image" content="{esc(base + "/og-image.png", quote=True)}">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:image:type" content="image/png">',
        f'<meta property="og:image:alt" content="{esc(SITE, quote=True)}">',
        f'<meta property="og:locale" content="{OG_LOCALE[lang]}">',
    ]
    lines += [f'<meta property="og:locale:alternate" content="{OG_LOCALE[o]}">'
              for o in LANGS if o != lang]
    lines += [
        '<meta name="twitter:card" content="summary_large_image">',
        f'<meta name="twitter:title" content="{esc(title, quote=True)}">',
        f'<meta name="twitter:description" content="{esc(desc, quote=True)}">',
        f'<meta name="twitter:image" content="{esc(base + "/og-image.png", quote=True)}">',
        '<meta name="theme-color" content="#ffffff">',
    ]
    return "\n    ".join(lines)


def render_page(name: str, page: str, lang: str, ver: str, base: str,
                api: str, ws: str, sitekey: str) -> str:
    raw = (PAGES / name).read_text(encoding="utf-8")
    title, _ = OG_TEXTS[page][lang]
    tags = build_tags(lang=lang, page=page, base=base, path="/" + page if page != "index" else "/")
    out = HTML_LANG_RE.sub(f'<html\\1lang="{lang}"', raw, count=1)
    out = TITLE_RE.sub(lambda m: f"{m.group(1)}{html.escape(title)}{m.group(2)}", out, count=1)
    if "<!-- OGP-START -->" in out and "<!-- OGP-END -->" in out:
        head, rest = out.split("<!-- OGP-START -->", 1)
        _, tail = rest.split("<!-- OGP-END -->", 1)
        out = f"{head}<!-- OGP-START -->\n    {tags}\n    <!-- OGP-END -->{tail}"
    out = STATIC_RE.sub(rf"\1/static/\2?v={ver}", out)
    out = out.replace('name="wd-wsonly" content="0"',
                      'name="wd-wsonly" content="1"')
    # API/WS/Turnstile注入 (head末尾)
    inject = (f'\n    <meta name="wd-api" content="{html.escape(api, quote=True)}">'
              f'\n    <meta name="wd-ws" content="{html.escape(ws, quote=True)}">'
              f'\n    <meta name="wd-turnstile-site" content="{html.escape(sitekey, quote=True)}">')
    if sitekey:
        inject += ('\n    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"'
                   ' async defer></script>')
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


def main() -> int:
    cfg = load_config()
    ts_cfg = cfg.get("turnstile") if isinstance(cfg.get("turnstile"), dict) else {}
    base = (os.environ.get("WD_BASE") or cfg.get("siteUrl") or "https://example.com").rstrip("/")
    api = os.environ.get("WD_API") or cfg.get("apiBase") or "https://api.example.com"
    ws = os.environ.get("WD_WS") or cfg.get("wsUrl") or "wss://api.example.com/ws"
    sitekey = os.environ.get("TURNSTILE_SITE_KEY") or ts_cfg.get("siteKey", "")
    ver = asset_version()

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "static").mkdir(parents=True)
    # static copy
    for p in STATIC.rglob("*"):
        if p.is_file():
            rel = p.relative_to(STATIC)
            dst = DIST / "static" / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dst)

    specs = [("index.html", "index", "/"), ("help.html", "help", "/help"),
             ("admin.html", "admin", "/admin")]
    for name, page, path in specs:
        # 既定言語はそのまま配置
        for lang in LANGS:
            body = render_page(name, page, lang, ver, base, api, ws, sitekey)
            if lang == "ja":
                (DIST / name).write_text(body, encoding="utf-8")
            d = DIST / lang / ("" if page == "index" else page)
            if page == "index":
                (DIST / lang).mkdir(parents=True, exist_ok=True)
                (DIST / lang / "index.html").write_text(body, encoding="utf-8")
            else:
                d.mkdir(parents=True, exist_ok=True)
                (d / "index.html").write_text(body, encoding="utf-8")

    headers = """\
/static/*
  Cache-Control: public, max-age=31536000, immutable
/*.html
  Cache-Control: public, max-age=300
/
  Cache-Control: public, max-age=300
/admin
  Cache-Control: no-store
"""
    (DIST / "_headers").write_text(headers, encoding="utf-8")
    print(f"built dist/ ver={ver} base={base} api={api}")
    for label, val in (("siteUrl", base), ("apiBase", api), ("wsUrl", ws)):
        if "example.com" in val:
            print(f"WARN: {label}が既定値のまま ({val})。"
                  " config.local.jsonc か環境変数で設定してください", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
