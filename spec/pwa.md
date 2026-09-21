# PWA

## ねらい

インストール（ホーム追加）対応。オフライン動作はしない。
リアルタイム性が命のため、キャッシュは版付き静的アセットのみ。
HTML・API・WS・OGP画像のキャッシュは禁止（新旧フロント混在で
`deploy.md` の WS 1006 問題を起こすため）。

## ソース配置

| ソース | ビルド後 | 備考 |
| --- | --- | --- |
| `static/manifest.json` | `dist/manifest.json` | アイコンURLに `?v=` 版付与（HTMLと同一版） |
| `static/sw.js`（テンプレート） | `dist/sw.js` | `__WD_SW_VERSION__` に `?v=` 版を注入。`dist/static/` には置かない |
| （なし） | `dist/static/manifest.json` | 置かない（版なし参照の混入防止） |
| `static/img/favicon.ico` | `dist/favicon.ico` + `dist/static/img/` | ビルドが直下にも配置 |
| `static/img/apple-touch-icon.png` | `dist/apple-touch-icon.png` + `dist/static/img/` | 同上 |
| `static/js/pwa.js` | `dist/static/js/pwa.js?v=` | SW登録専用スクリプト |

Python（`app/`）は凍結（`architecture.md`）のため、Python側に
`/manifest.json`・`/sw.js` ルートは作らない。PWAはdist（Pages）配信のみ。

## アイコン方針（切り取りなし）

- 全PWAアイコンは `static/img/logo.png`（2048正方形・透過）の
  **全体縮小のみ**。切り取り（トリミング）はしない。
- `icon-192.png` / `icon-512.png`（`purpose: any`）：縮小そのまま、透明維持。
- `icon-maskable-192.png` / `icon-maskable-512.png`：80%に縮小して
  ダーク背景（`#0b0b0f` = ライト/ダーク共通の `--page`）中央に配置。
  maskableのセーフゾーン制約を満たしつつ全体が見える。
- `apple-touch-icon.png`（180）：縮小して黒背景に平坦化
  （iOSは透過不可のため）。
- `favicon.ico`（16/32/48マルチ）：縮小そのまま。
- 再生成スクリプトは残していない。作り直す場合は上記ルールに従うこと。

## manifest

- `static/manifest.json`：`id`・`start_url`・`scope` = `/`、
  `display: standalone`、`theme_color`・`background_color` = `#0b0b0f`。
- `icons` は any 192/512 + maskable 192/512 の4点。
- ソースのアイコンURLは版なし `/static/...` のまま。
  ビルド時に `?v=` 版を付与したものを `dist/manifest.json` に生成する
  （`_headers` の `immutable` 長期キャッシュと不整合を起こさないため）。
- `shortcuts`：`/`（Canvas）・`/help`（Help）・`/notices`（Notices）。
- `pages/*.html` の共通head：`mobile-web-app-capable` /
  `apple-mobile-web-app-capable` / status-bar / application-name /
  icon（favicon.ico + icon-192）/ apple-touch-icon / manifest リンク。
- 副次修正：`help.html`・`admin.html` の壊れ参照 `/static/logo.png`
  （存在しない。正しくは `/static/img/logo.png`）をPWA整備に合わせて修正。
  `help.html` の `<img>` も同様。

## Service Worker（`static/sw.js`）

- 版付き `/static/*?v=` のみ cache-first + 実行時充填。
  先読み（precache）はしない。
- 以下はすべて素通し：ナビゲーション（HTML）、`?v=` なし、`/api/*`、
  `/ws`、`/og-image.png`、クロスオリジン（jsdelivr等）。
- `install` で `skipWaiting`、`activate` で旧 `pixdraw-static-*`
  キャッシュ削除 + `clients.claim`。
- キャッシュキーに版を含めるため、デプロイ毎に旧版は自動破棄される。
- `frontend/build.py` の `_headers`：`/sw.js` は `no-cache`
  （毎回再検証、更新検知用）。`immutable` を付けてはならない。

## pwa.js

- `navigator.serviceWorker.register("/sw.js", { scope: "/" })` のみ。
- https/localhost以外・登録失敗時は黙って無効
  （開発サーバ等に `/sw.js` が無い場合も無害）。
- 全ページ（index/help/notices/admin）で `defer` 読込。i18n・wd-* 非依存。
- `wd-*.js` の読み順規約（`wd-state`→…→`wd-main`）の対象外
  （トップレベル共有を使わない自己完結IIFEのため）。
