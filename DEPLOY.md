# デプロイ手順 (Pages静的 + Rustバックエンド)

構成: `Cloudflare Pages(dist/)` + `VPS上のRust(api)+Postgres+Valkey` + `cloudflared tunnel`。
`/api/*`はキャッシュBYPASS、`GET /og-image.png`のみ60秒キャッシュ。

## 0. 前提

- Cloudflareアカウント + ドメイン (例: `example.com`)
- VPS (OCI Always Free 2OCPU/12GB以上推奨)
- ローカルに Node 20+ / Rust 1.98+ / uv / wrangler (`npm i -g wrangler`)

## 1. Cloudflare準備

1. Turnstile作成: Dash → Turnstile → Add widget (managed invisible)
   - `siteKey` を控える、`secretKey` を控える
2. DNS: `www` → Pages、`api` → Tunnel (後で自動登録)
3. SSL: Full Strict
4. WAF Rate Limiting (Freeは10秒単位):
   - `POST /api/session` → 10req/10s/IP → Managed Challenge
   - `POST /api/account/*` → 10req/60s/IP → Block 10分
   - `POST /api/place` → 120req/10s/IP → Challenge
   - `/ws` handshake → 30req/10s/IP
5. Cache Rules: `api.example.com/api/*` → Bypass、`api.example.com/og-image.png` → Edge 60s
6. Bot Fight Mode: ON

## 2. バックエンド (VPS)

```bash
git clone <repo> && cd world-drawer
cp backend/.env.example backend/.env  # DATABASE_URLを本番値に
docker compose -f backend/compose.yml up -d pg valkey

# config.local.jsonc (Git管理外) に本番値を書く
cat > config.local.jsonc <<'EOF'
{
  "databaseUrl": "postgresql://postgres:SECRET@127.0.0.1:5432/worlddrawer",
  "redisUrl": "redis://127.0.0.1:6379/0",
  "siteUrl": "https://www.example.com",
  "corsOrigins": ["https://www.example.com"],
  "trustedProxies": ["127.0.0.1", "::1"],
  "adminTokens": ["<自分のwd_token>"],
  "turnstile": {
    "enforce": true,
    "siteKey": "<TURNSTILE_SITE_KEY>",
    "secretKey": "<TURNSTILE_SECRET>",
    "timeoutSec": 5
  }
}
EOF

# 旧SQLiteからの移行 (初回のみ。data/world.dbは残す)
uv run python main.py --copy-sqlite-to-pg

# Rust起動 (どちらか片方でいい。Docker不要)

## A. Dockerで動かす場合

```bash
docker build -t wd-backend ./backend
docker run -d --name wd-backend --restart always --network host \
  -e DATABASE_URL='postgresql://postgres:SECRET@127.0.0.1:5432/worlddrawer' \
  -v $PWD/config.jsonc:/app/config.jsonc:ro \
  -v $PWD/config.local.jsonc:/app/config.local.jsonc:ro \
  wd-backend
```

## B. Dockerなし (systemd+直ビルド)

```bash
# Postgres + Valkeyを直入れ (Ubuntu/Debian例)
sudo apt install -y postgresql valkey
sudo systemctl enable --now postgresql valkey

sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'SECRET';"
sudo -u postgres psql -c "CREATE DATABASE worlddrawer;"

# ビルド
cargo build --release --manifest-path backend/Cargo.toml

# 配置
sudo useradd -r -s /usr/sbin/nologin world-drawer || true
sudo mkdir -p /opt/world-drawer && sudo chown world-drawer:world-drawer /opt/world-drawer
cp -r backend config.jsonc config.local.jsonc migrations /opt/world-drawer/ 2>/dev/null || true
cp backend/target/release/world-drawer-backend /opt/world-drawer/backend-run
sudo cp backend/deploy/world-drawer-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now world-drawer-backend
```

共通: health確認
curl http://127.0.0.1:5787/healthz  # → ok
```

## 3. Tunnel (オリジン隠蔽)

```bash
cloudflared tunnel login
cloudflared tunnel create wd-api
cloudflared tunnel route dns wd-api api.example.com
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: wd-api
credentials-file: ~/.cloudflared/<id>.json
ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:5787
  - service: http_status:404
EOF
cloudflared tunnel run wd-api  # systemd化推奨
```

## 4. フロント (Pages)

```bash
WD_BASE=https://www.example.com \
WD_API=https://api.example.com \
WD_WS=wss://api.example.com/ws \
TURNSTILE_SITE_KEY=<SITE_KEY> \
uv run python frontend/build.py
# env未指定時は config.local.jsonc の siteUrl / apiBase / wsUrl / turnstile.siteKey を読む

npx wrangler login
npx wrangler pages deploy dist/ --project-name world-drawer
# Custom domain: www.example.com をPagesに割当
```

## 5. 疎通確認

```bash
curl https://api.example.com/healthz
curl https://api.example.com/api/bounds
# ブラウザ: https://www.example.com → Turnstile通過 → 描画・配置・WSカーソル確認
# 管理: localStorageのwd_tokenをadminTokensに入れて /admin
```

## 6. 運用

- 再デプロイ (フロントのみ): `frontend/build.py` → `wrangler pages deploy`
- バックエンド更新: `docker build` → `docker restart wd-backend` (migrationは起動時自動)
- 緊急時: `turnstile.enforce=false` + 再起動でTurnstileバイパス、Cloudflare Under Attack Mode
- `data/world.db` はアーカイブとして残置。削除しないこと
