# 管理API（最小契約）

管理ページ（`static/js/admin-page.js`・`wd-admin.js`）を動かすための最小集合。
現状Rustは `presence` のみ等でページがほぼ表示できないため、以下へ拡張する。

## `POST /api/admin/status`

```json
{"ok": true, "presence": 12, "sockets": 12,
 "banned": [{"ip": "1.2.3.4", "until": 0.0}],
 "config": {"placePerMinPerIp": 180, "sessionPerHour": 30,
            "requireSocketForPlace": false, "maxSocketsPerIp": 64}}
```

- `sockets` は `presence` と同値（素WSで区別なし）。
- `banned` は有効分のみ（期限切れ・壊値は掃除）。
- `config` は表示用。`requireSocketForPlace` は廃止のため常に `false` を返す。
- `topPlaceIps` / `topSessionIps` は**返さない**（仕様）:
  レートキーの全走査は重く、管理ページ側の該当表を簡素化する。

## `POST /api/admin/lookup {uid}`

```json
{"ok": true, "user": {"uid": "...", "name": "...", "color": "#rrggbb",
 "level": 1, "xp": 0, "inventory": {"glow": 0, "...": 0},
 "country": null, "showCountry": true,
 "touchedCells": 0, "lastIp": "1.2.3.4", "online": true}}
```

- `touchedCells` は `SELECT COUNT(*) FROM pixels WHERE by=$1`（管理専用のため許容）。
- `lastIp` は Redis `wd:lastip`（token→`ip|ts`）。place時に記録する（`noteLastIp`相当）。
- `online` はHub内のuid存在で判定。
- 管理ページのbanボタンは `lastIp` を使うため、これがないとban運用ができない。

## `POST /api/admin/rollback {uid, limit?}`

- 対象の履歴セル（`limit` 既定1000・上限5000、超過は `truncated:true`）を
  新しい順に巻き戻す。最新行が対象者でなければ `skipped`。
- 復元は **bitmask数値で `t` 列に束縛する**（現状の文字列束縛はバグB3）。
  `coats` は履歴準拠（現状の1固定をやめる）、`chalkUntil/shieldUntil` は0消去。
- XPは `xp_base/xp_pow` のconfig値で巻き戻す（現状の3.0/1.5固定はバグB4）。
  inventory・報酬の巻き戻しはガチャ実装後に合わせる（現段階ではXPのみ）。
- 応答: `{ok,uid,restored,skipped,truncated,level,xp,events}`。
  `events` の各要素はピクセルセル形＋`x,y`（現状の `{kind:"pixel"}` 包みはやめ、
  フロントがそのまま描ける形にする）。
- 巻き戻し後は該当タイル版をbumpし、購読者へバイナリ配信する（実装済み手順を維持）。

## `POST /api/admin/ban {ip, seconds?}`（実装済み）

- 変更なし。執行側（`anti-grief.md`）の修正で実効化される。
