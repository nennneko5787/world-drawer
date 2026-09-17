# アーキテクチャ

## 構成（3分離）

```text
Cloudflare Pages (dist/)          Rust API (backend/, Axum)
  index/help/admin × 5言語  --->    /api/* (no-store)
  /static/* (immutable)             /ws (素WebSocket・バイナリ)
  /og-image.png へのOGP参照  --->    /og-image.png (60s cache)
                                    /healthz
                           Postgres + Redis(Valkey)
```

- ページ・静的配信はRustの責務ではない。`frontend/build.py` が `pages/` と
  `static/` から `dist/` を生成する（OGP注入・`?v=`版付与・`wd-wsonly=1`固定）。
  Rustにページ・静的配信は作らない（仕様）。
- Python（`main.py`・`app/`）は起動しない。SQLite・旧JSON取込・
  `--copy-sqlite-to-pg`・Socket.IOは廃止済み（仕様）。

## Rustプロセス

- 起動: `backend/src/main.rs`。`config.jsonc` + `config.local.jsonc` 読込 →
  Postgres接続 → `sqlx::migrate!` → Redis接続（必須）→ listen。
- ミドルウェア: 動的JSON用brotli最速圧縮、10秒タイムアウト、
  リクエスト64KB制限、CORS（`corsOrigins`）。
- 失効チケット掃除タスク（60秒毎、`main.rs:53-61`）。

## データストア

| 用途 | 場所 | 備考 |
| --- | --- | --- |
| 正本 | Postgres（`backend/migrations/*.sql`） | `pixels` / `users` / `history` / `notices` / `meta` |
| レート・ban・最終IP | Redis `wd:rate:*` / `wd:bans` / `wd:lastip` | 障害時はfail-open（可用性優先） |
| タイル版 | プロセス内メモリ（`tiles.rs`） | 再起動で0に戻る（次回fetchで再取得されるため無害） |
| WS購読・接続 | プロセス内メモリ（`ws.rs` Hub） | **レプリカ跨ぎのファンアウトなし** |

## 単一レプリカ制約（仕様）

`Hub` と `TileVersions` はメモリ内のため、APIを複数レプリカで動かすと
WS配信（購読タイル宛）とタイル版がレプリカごとに分断される。
多重化する場合は Redis pub/sub 中継の追加が前提。それまでは単一レプリカ運用。

## DBスキーマ要点（`migrations/001_init.sql` + `002`〜`004`適用後）

- `pixels(x, y, c INT, t SMALLINT, by, coats SMALLINT, shieldUntil, chalkUntil)`、`PRIMARY KEY(x,y)`
- `users(token, uid, name, color INT, inventory, cooldownUntil, level, xp, transferCode, passwordHash, country, showCountry)`
- `history(id, x, y, uid, c INT, t SMALLINT, at, undone BOOL, xp, rewardInk, rewardAmount)`
- `notices(id, title, body, createdAt, updatedAt)`（`migrations/005_notices.sql`。新しい順に `id DESC` で読む）
- ink bitmask: `chalk=1 ghost=2 glow=4 rainbow=8 shield=16 normal=0 erase=32`（`ws_proto.rs:41-43`）
