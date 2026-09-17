# world-drawer

ブラウザで遊べる無限キャンバスのお絵かきボード（r/place 風）。全員で1つの世界に1マスずつ描画し、リアルタイムに同期されます。

- 無限キャンバス（負座標OK）＋グリッド・原点軸・座標表示
- 1マス配置ごとにクールダウン（レベルで短縮）・経験値・レベルアップ
- 特殊インク（発光 / 虹色 / ゴースト）のガチャ、3秒以内の取り消し
- 名前付きカーソル・オンライン一覧・履歴・設計図・スポイト・カスタムカラーピッカー
- アカウント引っ越し（コード＋パスワード）・荒らし対策・ライト/ダーク/自動テーマ
- 日本語 / English / 한국어 / 简体中文 / 繁體中文 の5言語対応

## 必要要件

- Python 3.13 以上
- [uv](https://docs.astral.sh/uv/)（依存管理・起動に使用）

## セットアップ

```powershell
# 取得
git clone https://github.com/nennneko5787/world-drawer.git
cd world-drawer

# 依存導入
uv sync
```

初回起動時に `data/world.db`（SQLite）が自動作成されます。旧JSON保存（`data/canvas.json` 等）があれば初回のみ自動取り込みします。

`config.jsonc` は無記入のままで動きます。公開する場合は `siteUrl`、
管理画面を使う場合は `adminUIDs` を設定してください（詳細は下の
設定表・公開例を参照）。

### 多人数向けの追加セットアップ（PostgreSQL・Redis・nginx）

単体動作には不要です（既定は `data/world.db` のSQLite）。
マルチワーカーにする場合は **PostgreSQL が必須**です
（SQLite ではプロセス跨ぎで `database locked` が頻発します）。

```powershell
# PostgreSQL (例: Docker)
docker run -d --name wd-pg -p 5432:5432 --restart always `
  -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=worlddrawer postgres:18
```

```jsonc
// config.jsonc に追記 (環境変数 DATABASE_URL があればそちらが優先)
"databaseUrl": "postgresql://postgres:secret@127.0.0.1:5432/worlddrawer",
"dbPoolSize": 10,
```

```powershell
# 既存のSQLiteデータを移行する場合 (ワーカー停止中に実行)
uv run python main.py --copy-sqlite-to-pg
# 移行先にゴミがある場合のみ全消去して複写
uv run python main.py --copy-sqlite-to-pg --force
```

- `workers数 × dbPoolSize` がDBの `max_connections` を超えないよう調整してください
- 起動ログに `database backend: postgres` と出れば連携OKです

```powershell
# Redis (例: Docker)
docker run -d --name wd-redis -p 6379:6379 --restart always redis
```

```jsonc
// config.jsonc に追記
"redisUrl": "redis://127.0.0.1:6379/0",
```

- DockerなしWindows: WSL2 上で `sudo apt install redis-server` などでも可
- 起動ログに `redis connected` と出れば連携OK（出なければ
  `/api/admin/status` の `redis` 欄が `ok: false` のまま縮退動作します）
- nginx は公式サイトの Windows 版zipを展開し、下の `nginx` 例を
  `conf/nginx.conf` に反映して `nginx.exe` を起動します
  （`alias` のパス等は環境に合わせて変更してください）

## 起動

```powershell
# 開発・手元確認用 (http://127.0.0.1:8000)
python main.py

# 本番用 (http://127.0.0.1:5787)
uv run uvicorn main:app --port 5787
```

ヘルプは `/help` で表示されます。

## 設定

`config.jsonc`（コメント付きJSON。末尾カンマ可）でゲームバランスを変更できます。変更はサーバー再起動後に反映されます。不正な値・不明なキーは警告のうえ既定値を使います。

サーバー固有の値（本番のトークン等）は `config.local.jsonc`（Git管理外・同形式・優先）に書いてください。`config.jsonc` を直接書き換えると `git pull` 時に競合します。

| 項目 | 内容 |
| --- | --- |
| `cooldownSec` / `minCooldown` / `cooldownDecay` | Lv1の秒数・下限・レベルごとの倍率 |
| `xpPerPlace` / `xpBase` / `xpPow` | 配置ごとの経験値・必要経験値の係数と指数（レベル上限なし） |
| `background` / `coordLimit` / `maxNameLen` / `maxBboxPixels` | 背景色・座標上限・名前の長さ・視野取得の上限 |
| `rewardChance` / `rewardMin` / `rewardMax` | 特殊インクの当選確率と付与量 |
| `shieldMinutes` | シールドの保護時間（分） |
| `chalkMinutes` | チョークの保持時間（分） |
| `maxHistoryPerCell` / `maxHistoryCells` | 履歴の保持上限 |
| `minPasswordLen` / `maxPasswordLen` / `sessionPerHour` / `loginMaxFails` / `loginLockSec` | アカウント関連の制限 |
| `placePerMinPerIp` / `placeRadius` / `trustedLevel` | 荒らし対策（IP共有上限・低レベルの配置半径・半径制限が外れるレベル） |
| `redisUrl` | 空なら単体動作。設定するとマルチワーカー対応（下記） |

## 構成

```text
main.py              配線のみ（FastAPI + Socket.IO）
app/routes/          ページ・REST API・静的ファイル配信（gzip/brotli圧縮＋キャッシュ）
app/services/        データベース・ユーザー・キャンバス・presence・Socket.IO
app/objects/         設定・Pydanticモデル
pages/               index.html・help.html
static/              css・js（テーマ・i18n・メイン）
config.jsonc         ゲームバランス設定
data/                SQLite本体（Git管理外）
```

配置・クールダウン・所持インク・配置半径の判定はすべてサーバー側で行います。クライアント側の表示（クールダウン残量・境界線など）は目安です。

## 開発

```powershell
uv run ruff check .      # Lint
uv run ruff format .     # 整形
uv run ty check          # 型チェック
```

JSの構文確認は `node --check` で行えます（対象: `static/js/wd-*.js`）。
フロントは機能別の classic script 分割（`wd-state` → … → `wd-main` の順に読込、トップレベルスコープ共有）です。
後続ファイルの関数をトップレベルで直接参照せず、実行時解決（`(...a) => f(...a)`）にしてください。

## 注意

- `data/` 配下（描画内容・ユーザー情報）はリポジトリに含めません
- 本番運用時はバックアップを推奨します

## 公開例：Cloudflare Tunnel

リバースプロキシなしで公開する場合の例です。`cloudflared` が自ホストから出るため、
既定の `trustedProxies`（`127.0.0.1`・`::1`）のままでクライアントIPを取得できます。

```powershell
cloudflared tunnel --url http://127.0.0.1:5787
```

- 接続元IPは `CF-Connecting-IP` ヘッダから取得します
- 国旗は最終接続国の `CF-IPCountry` から自動設定されます（一覧・履歴に表示、アカウントパネルで表示/非表示のみ切替可）
- `trustedProxies` に含まれる相手からの接続でのみ `CF-Connecting-IP` /
  `X-Forwarded-For` を信用し、直結リクエストのヘッダは偽装可能なため無視します
- 別構成のリバースプロキシを使う場合は、その出口IP/CIDRを `trustedProxies`
  （`config.jsonc`）に追加してください

## マルチワーカー（多人数向け）

1ワーカーで捌き切れなくなったら（502・タイムアウト増）、Redis連携で
ワーカーを増やせます。プレイヤー一覧・カーソル・レート制限・ban は
Redis で共有されるため、ワーカーを跨いでも壊れません。

```powershell
# Redisを用意し、config.jsonc に設定（例: "redisUrl": "redis://127.0.0.1:6379/0"）
```

## 方式A: WebSocket専用（簡単・推奨）

`config.jsonc` で `"forceWebsocket": true` にすると Socket.IO が
WebSocket専用になり、振り分けの固着が不要になります。
プロキシ追加なしで単一ポートのマルチワーカーが動きます。

```powershell
uv run uvicorn main:app --port 5787 --workers 8
cloudflared tunnel --url http://127.0.0.1:5787
```

- 代償：WebSocketを塞ぐ回線（厳しい社内・学内LAN等）では接続できません
- 通常（`false`）は polling+websocket の併用で互換性優先です

## 方式B: polling併用＋nginx（互換維持）

`forceWebsocket` を使わない場合は**前段にスティッキーな振り分けが
必須**です（Socket.IO の polling のため）。`--workers` の単一ポートでは
OSが振り分けて固着しないため、別ポート起動＋リバースプロキシでの
振り分けにします。

```powershell
# ワーカーを別ポートで複数起動
uv run uvicorn main:app --port 5781
uv run uvicorn main:app --port 5782
# … 必要な数だけ
```

nginx の例:

```nginx
upstream world_drawer {
    ip_hash;  # 同一IPを同一ワーカーへ (Socket.IOのpollingに必須)
    server 127.0.0.1:5781;
    server 127.0.0.1:5782;
}
server {
    listen 5787;
    location / {
        proxy_pass http://world_drawer;
        proxy_http_version 1.1;
        # WebSocket用
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

- 公開は `cloudflared tunnel --url http://127.0.0.1:5787` のように
  nginx に向ける（`CF-Connecting-IP` はそのまま透過するため、
  既定の `trustedProxies` のままでクライアントIPを取得できます）
- Cloudflare Tunnel 単体にはスティッキー機能がないため、polling併用時は
  `cloudflared → nginx(ip_hash) → 各ワーカー` の構成にしてください
  （方式Aなら `cloudflared` 直結で可）

## 3分離（大規模向け・任意）

静的配信・WS・APIを別々にすると、負荷箇所ごとに台数を変えられます。
WS専用（`forceWebsocket` 推奨。polling併用時は ip_hash 側へ）・
API+ページの2種プールと、nginx での静的直配信の例:

```powershell
# WSプール (Socket.IOのみ)
uv run uvicorn main:ws_app --port 5791
uv run uvicorn main:ws_app --port 5792
# APIプール (ページ・REST・OGP画像)
uv run uvicorn main:api_app --port 5781
uv run uvicorn main:api_app --port 5782
```

```nginx
upstream world_ws {
    # 方式A (WS専用) なら固着不要。方式Bならここも ip_hash にする
    server 127.0.0.1:5791;
    server 127.0.0.1:5792;
}
upstream world_api {
    server 127.0.0.1:5781;
    server 127.0.0.1:5782;
}
server {
    listen 5787;
    # 静的ファイルはnginxから直配信 (版クエリ ?v= 付きのため長期キャッシュ可)
    location /static/ {
        alias C:/path/to/world-drawer/static/;
        expires 1h;
    }
    location /socket.io/ {
        proxy_pass http://world_ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
    location / {
        proxy_pass http://world_api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

- WS・APIどちらのプールも同じ `config.jsonc`（`redisUrl` 必須）を使います。
  配置イベント等は Redis 中継で全ワーカーに届きます
- `alias` のパスは配置先に合わせて変更してください（`~` や相対パスは不可）
- `redisUrl` が空のまま `--workers` を付けると、プレイヤー一覧・制限が
  ワーカーごとに分断されるため推奨しません（単体動作のままが無難です）
- Redis障害時は可用性優先で縮退します（制限は緩め・一覧は空）。
  `/api/admin/status` の `redis` 欄で状態を確認できます
- SQLite はWALモードで複数プロセスから利用します。配置などの
  読み→書きは直列化しています。多人数・多ワーカー運用時は PostgreSQL
  （上の追加セットアップ参照）を使ってください

## 更新手順（本番）

DBマイグレーションは起動時にも走りますが、複数プロセスの同時起動で
競合するため、デプロイ時は再起動**前**に分離実行してください。

```powershell
# ワーカーを停止してから
git pull
uv sync
uv run python main.py --migrate
# ワーカーを起動
```

サーバー固有値は `config.local.jsonc`（Git管理外）に置けば、
`pull` 時の競合を避けられます。
