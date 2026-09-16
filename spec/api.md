# REST契約（正準）

`backend/src/routes/mod.rs:44-66` が正。特に記載がなければ `cache-control: no-store`。

## 認証（仕様）

- `Authorization: Bearer <token>` のみ。body/query内のtokenは受付ない
 （`backend/src/auth.rs`、フロント `static/js/wd-auth.js:27-37` もBearerのみ送信）。
- 長さ0・65文字以上は `401 missingToken`。
- 管理系はBearerが `adminTokens` のいずれかと一致すること（定数時間比較風、`admin.rs:9-17`）。

## エンドポイント

| method・path | 実装 | 概要 |
| --- | --- | --- |
| `GET /api/canvas` | `routes/canvas.rs:22` | bboxなし→metaのみ。bboxあり→ピクセル（上限超えは `truncated:true` で空）。`pixelCount` は廃止（全件COUNTが重い上にフロント未使用） |
| `GET /api/tiles` | `routes/tiles.rs:79` | タイル差分（`need`/`known`）。`{tiles, pending}` |
| `GET /api/bounds` | `routes/canvas.rs:114` | `{count}` または `{count,minX,minY,maxX,maxY}` |
| `GET /api/me` | `routes/me.rs:10` | Bearerの自情報。不存在は `404 noUser`（自動作成しない） |
| `POST /api/session` | `routes/session.rs:19` | Turnstile必須で新規発行。`{ok,token,uid,profile,inventory,cooldownUntil,cooldown,level,xp,xpNeeded,hasAccount,country,showCountry}` |
| `POST /api/ws-ticket` | `routes/ticket.rs:8` | WS用使い切りチケット（30秒）。`{ok,ticket,turnstileRequired}`（helloの検証要否。クライアントはtrueの時だけTurnstile実行） |
| `POST /api/place` | `routes/place.rs:22` | 配置（`{x,y,color,ink}`）。成功時は `ok:true` + `pixel/by/cooldownUntil/cooldown/inventory/reward/level/xp/xpNeeded/leveledUp` |
| `POST /api/undo` | `routes/undo.rs:36` | 3秒取消（`{x,y,prevEmpty,prevC,prevT,prevCoats}`）。成功時は `pixel/by/level/xp/xpNeeded/inventory` |
| `GET /api/history?x&y&limit&beforeId` | `routes/history.rs:16` | `{ok,x,y,items,hasMore}`（`limit` 1-100、既定20） |
| `POST /api/profile` | `routes/profile.rs:18` | `{name,color,showCountry?}` 更新 |
| `POST /api/account/issue` | `routes/account.rs:126` | 引っ越しコード発行（既存ユーザ必須） |
| `POST /api/account/login` | `routes/account.rs:171` | コード+パスワードで切替・`from_token`で統合。`{ok,token,uid,merged,profile}` |
| `POST /api/admin/status` | `routes/admin.rs:36` | `admin.md` 参照 |
| `POST /api/admin/lookup` | `routes/admin.rs:47` | `admin.md` 参照 |
| `POST /api/admin/rollback` | `routes/admin.rs:76` | `admin.md` 参照 |
| `POST /api/admin/ban` | `routes/admin.rs:218` | `{ip,seconds?}`。`seconds<=0` で解除 |
| `GET /api/users` | `routes/users.rs:13` | WS不可時のフォールバック。`{online:[{uid,name,color,level}],count,truncated}`（仕様としてlean） |
| `GET /ws` | `routes/mod.rs:69` | WS（`ws-protocol.md`） |
| `GET /og-image.png` | `routes/canvas.rs:142` | `ogp.rs` 原点中心レンダ。60s cache |
| `GET /healthz` | `routes/mod.rs:65` | `ok` |

## 配置はRESTのみ（仕様）

WS経由placeは存在しない。クライアント（`static/js/wd-net.js:608-685`）も
`POST /api/place` のみを使い、WSは受信（pixel/cursor/join/leave）と
送信（cursor/watch/hello）専用。WSにplaceを足さない。

## 主なエラーコード

`missingToken` `noUser` `outOfBounds` `badColor` `unknownInk` `noInk`
`cooldown` `shielded` `tooFar` `banned` `ipBusy` `badPrev` `tooLate`
`changed` `noUndo` `badPassword` `badLogin` `locked` `turnstileRequired`
`badUid` `badIp` `rateLimited` `forbidden` `busy`

## ピクセルセルの形

```json
{"c": "#rrggbb", "t": "normal|erase|chalk+ghost等", "by": "uid|null",
 "coats": 1, "s": 残秒, "e": 残秒, "e0": 全秒}
```

`s`（シールド残）・`e`/`e0`（チョーク残/全）は期限付きセルのみ付与。
`e`/`e0`/`s` はfloat秒（Pythonの整数秒とは異なるが、フロントは両対応のため正準とする）。
消去は `t:"erase"` 扱い（`ws_proto.rs:69`）。
