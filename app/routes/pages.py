"""ページルート (HTML配信 + 動的OGP画像)。"""

from __future__ import annotations

import re

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response

from app.services import config as cfg
from app.services import ogp, ogp_image, staticcache
from app.services.config import pagesDir

router = APIRouter()

_STATIC_URL_RE = re.compile(r"""(["'])/static/([^"'?#\s]*)""")


def versionedStaticUrls(body: str) -> str:
    """HTML中の /static/ URL に ?v=版クエリを付与する。

    ブラウザの長期キャッシュ (max-age=3600) とHTML (max-age=300) の更新
    タイミング差による新旧スキュー (古いJSが新しいHTMLの要素を掴めず
    null クラッシュして画面全体が死ぬ) を防ぐ。版はデプロイ=再起動で変わる。
    """
    ver = staticcache.assetVersion(cfg.staticDir)
    return _STATIC_URL_RE.sub(rf"\1/static/\2?v={ver}", body)


def applyWsOnly(body: str) -> str:
    """forceWebsocket時のみ transports指定metaを立てる (index.htmlのみ保有)。"""
    if "wd-wsonly" not in body:
        return body
    flag = "1" if cfg.forceWebsocket else "0"
    return body.replace('name="wd-wsonly" content="0"', f'name="wd-wsonly" content="{flag}"')


def baseUrlFor(request: Request) -> str:
    if cfg.siteUrl:
        return cfg.siteUrl
    return str(request.base_url).rstrip("/")


def localizedPage(name: str, page: str, request: Request, lang: str | None) -> HTMLResponse:
    queryLang = lang.strip() if lang else ""
    resolved = ogp.resolveLang(queryLang or None, request.headers.get("accept-language", ""))
    raw = (pagesDir / name).read_text(encoding="utf-8")
    body = ogp.localizeHtml(
        raw,
        lang=resolved,
        page=page,
        baseUrl=baseUrlFor(request),
        path=request.url.path,
        queryLang=queryLang or None,
    )
    body = versionedStaticUrls(body)
    body = applyWsOnly(body)
    body = applyPrevOrigins(body)
    return HTMLResponse(
        content=body,
        headers={"vary": "Accept-Language", "cache-control": "public, max-age=300"},
    )


def applyPrevOrigins(body: str) -> str:
    """移行元オリジンをmeta注入 (index.htmlのみ保有想定。なければ何もしない)。"""
    if 'name="wd-prev-origins"' in body:
        return body
    origins = ",".join(cfg.previousOrigins or [])
    inject = f'\n    <meta name="wd-prev-origins" content="{origins}">'
    return body.replace("</head>", f"{inject}\n</head>", 1)


def migrateShim(request: Request) -> HTMLResponse:
    """旧ドメイン配置用の移行shim (開発サーバー用。許可親は自baseUrl)。"""
    import html as _html
    import json as _json

    raw = (pagesDir / "migrate.html").read_text(encoding="utf-8")
    allow = _html.escape(_json.dumps([baseUrlFor(request)]), quote=True)
    body = raw.replace("<!--WD_MIGRATE_ALLOW-->", allow)
    return HTMLResponse(content=body, headers={"cache-control": "no-store"})


@router.get("/")
async def index(request: Request, lang: str | None = None) -> HTMLResponse:
    return localizedPage("index.html", "index", request, lang)


@router.get("/help")
async def helpPage(request: Request, lang: str | None = None) -> HTMLResponse:
    return localizedPage("help.html", "help", request, lang)


@router.get("/admin")
async def adminPage(request: Request, lang: str | None = None) -> HTMLResponse:
    """管理者用の操作ページ (API側でトークン検証。機微情報を扱うため保存抑止)。"""
    resp = localizedPage("admin.html", "admin", request, lang)
    resp.headers["cache-control"] = "no-store"
    return resp


@router.get("/migrate.html")
async def migratePage(request: Request) -> HTMLResponse:
    """ドメイン移行用shim。旧ドメイン側に置くファイルと同一内容 (開発用)。"""
    return migrateShim(request)


@router.get("/og-image.png")
async def ogImage(request: Request) -> Response:
    """原点付近の実キャンバス + 右下ロゴ (TTLキャッシュ + ETag)。"""
    png, etag, renderedAt, hit = await ogp_image.getOgpImage()
    headers = {
        "content-type": "image/png",
        "content-length": str(len(png)),
        "cache-control": f"public, max-age={ogp_image.CLIENT_MAX_AGE_SEC}",
        "etag": etag,
        "last-modified": ogp_image.httpDate(renderedAt),
        "x-ogp-cache": "HIT" if hit else "MISS",
    }
    if request.headers.get("if-none-match", "").strip() == etag:
        return Response(
            status_code=304,
            headers={k: v for k, v in headers.items() if k != "content-length"},
        )
    return Response(content=png, status_code=200, headers=headers)
