# config

`config.jsonc` + `config.local.jsonc`（後勝ち・deep merge）。
読込は `backend/src/config.rs:263-296`。

## 有効キー（Rustが読む）

| キー | 既定 | 用途 |
| --- | --- | --- |
| `databaseUrl` / `DATABASE_URL` | （必須） | Postgres接続 |
| `redisUrl` | （必須） | Redis接続 |
| `listen` | `127.0.0.1:5787` | 待ち受け |
| `corsOrigins` | `[]` | Pages URL列挙 |
| `adminUIDs` | `[]` | 管理UID一覧（プロフィール欄の #xxxxxx。先頭#・前後空白を許容） |
| `previousOrigins` | `[]` | 移行元オリジン (Pages側のみ使用。新サイトで旧URL列挙) |
| `trustedProxies` | `[]` | ヘッダ信用する相手（既定 `config.jsonc` で `127.0.0.1,::1`） |
| `turnstile` | enforce:true | `siteKey/secretKey/timeoutSec` |
| `cooldownSec/minCooldown/cooldownDecay` | `5.0/1.0/0.87` | クールダウン |
| `xpPerPlace/xpBase/xpPow` | `1/3.0/1.5` | XP・レベル |
| `background` | `#ffffff` | 空マス色・消去色（B8修正後） |
| `maxBboxPixels` | `100000` | `/api/canvas` 上限 |
| `tileRowCap/maxStaleTiles` | `20001/128` | `/api/tiles` 上限 |
| `trustedLevel/placeRadius` | `5/1000` | 半径制限（ガード実装後） |
| `requireSocketForPlace/maxSocketsPerIp` | `true/64` | 荒らし対策（`anti-grief.md`） |
| `placePerMinPerIp` | `60` | IP共有配置上限/分（本番は180で運用） |
| `chalkMinutes/shieldMinutes` | `30/60` | 期限 |
| `rewardChance/rewardMin/rewardMax` | `0.30/1/5` | ガチャ（実装済み） |
| `maxHistoryPerCell/maxHistoryCells` | `0/0(無効)` | どちらも0で無効=残す。履歴・rollback保全のため既定無効 |

## 固定キー（読まない・仕様）

軽量化のためノブを削る。値はコード固定。

| キー | 固定値 | 実装箇所 |
| --- | --- | --- |
| `coordLimit` | `1_000_000` | `place.rs:31` 他 |
| `maxNameLen` | `20` | `profile.rs:51` |
| `minPasswordLen/maxPasswordLen` | `8/128` | `account.rs:148` |
| `sessionPerHour` | `30/h` | `session.rs:55` |
| `loginMaxFails/loginLockSec` | `10/600s` | `account.rs:186` |
| `dbPoolSize` | `30` | `db.rs:9` |

## 廃止キー（仕様）

`forceWebsocket`（WS専用が既定）・`requireSocketForPlace`（廃止）・
`siteUrl/apiBase/wsUrl`（フロント用でサーバは読まない）・`debug/geo`系なし。

## 注意（B1・修正済み）

~~`DATABASE_URL` 環境変数が空でないとファイル全体を捨てて既定値で起動していた~~ →
修正済み。現在はファイル読込後に `DATABASE_URL` のみ上書きする。
