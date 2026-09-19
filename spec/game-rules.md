# ゲームルール

## クールダウン・XP・レベル（実装済み）

- 配置ごとにクールダウン `users::cooldown_for_level`（`backend/src/users.rs:47-51`）:
  `min + (base - min) × decay^(lv-1)`。既定 `5.0s / 1.0s / 0.87`。
  Python正準は `users.cooldownForLevel`（`app/services/users.py:171-175`）。
- 配置ごとに `xpPerPlace`（既定1）付与。`xpNeeded = max(1, base × lv^pow)`
  （既定 `3 / 1.5`、`users.rs:53-56`）。複数段上がり対応。
- 配置Tx内でユーザ行ロック→判定→書込を直列化（`routes/place.rs:72-86`）。
- サーバ判定は厳密（`remain > 0` で拒否、猶予なし。
  Python `canvas.py:checkCooldown`）。バランス変更になるため猶予を足さない。
- クライアントの表示と送信ゲートは同一式に統一する
  （`wd-ui.js:cooldownRemainSec`）:
  `remain = max(0, (cooldownUntil + 700ms - now)/1000)`。
  700msはRTT分の早読み（「準備OKなのに弾かれる」）防止用。サーバの厳密性は不変。
- 応答（配置成功・`cooldown` エラー・`userPayload`）は判定時のサーバ時刻 `now`
  （epoch秒）を同梱する。クライアントは `applyLevelData` で
  `serverOffsetMs` を学習（±60s超は無視・指数平滑）し、端末時計ズレを吸収する。
- 配置送信は in-flight ガード付き（`wd-net.js:placing`）。応答前の連打は
  送信せず残り秒トーストのみ。`cooldown` エラー・成功時は即 `updateCooldownUI()`。

## 特殊インク（実装済み: 消費側）

- 5種固定: `glow rainbow ghost chalk shield`（`place_logic.rs:6`）。
- 指定は `ink` 正準形（alphabeticalソート結合、例 `ghost+glow`）。
  重複・不明要素は `unknownInk`。
- `normal`/`erase` 以外は構成インクを各1消費。不足は `noInk` + 現在inventory返却。
- ghost重ね塗り: 同一セルへのghost再配置で `coats+1`（上限5、`place.rs:310-326`）。
  rainbowは下地色を維持。
- `erase` は行削除。応答色は **`cfg.background` に統一する**（現状 `#ffffff` 固定はバグB8）。

## チョーク・シールド（実装済み）

- chalk含有で `chalkUntil = now + chalkMinutes×60`、それ以外で上書き時は0に消去。
  期限切れは触れたセルだけ遅延削除（`place.rs:104-122`）＋読取時除外。
- shield含有で `shieldUntil = now + shieldMinutes×60`。他人・有効期限内は `shielded` + 残秒。
- undo復元時は両方0に消去（`undo.rs:147-153`、Python `canvas.py:477-480` と同等）。

## 報酬ガチャ（実装済み）

Python（`app/services/canvas.py:22-28,340-364`）と同値を正準とする。
フロントは `data.reward` トースト・helpの「30%で1〜5個」表記済み
（`wd-net.js:681`、`i18n.js` の `h_i5`）のため、未実装のままではインク入手経路が消滅する。

- 確率 `rewardChance`（既定0.30）で5種から均一に1種・`rewardMin〜rewardMax`（既定1〜5）個付与。
- 付与は配置Tx内でinventory加算し、応答 `reward:{ink,amount}`（なしは `null`）と
  `history(rewardInk, rewardAmount)` に記録する。
- undo時は当選分を没収（0止め、Python `canvas.py:505-506` と同等）。
- 乱数は `rand` crate（ゲーム内ガチャであり秘密情報ではない）。

## 配置半径（実装済み）

- `trustedLevel`（既定5）以上は無制限。未満は既存ピクセルからチェビシェフ距離
  `placeRadius`（既定1000）以内のセルのみ配置可。違反は `tooFar` + `radius` 返却。
- 判定は `SELECT 1 FROM pixels WHERE x BETWEEN ... AND y BETWEEN ... LIMIT 1`
  （Python `canvas.py:668-674` と同等、index-only）。
- キャンバス空（0ピクセル）の初手は許可。
- 他者presence近傍（Python `nearOtherPresence`）は**廃止**（仕様）:
  Rust Hubはcursor位置を保持せず、中継のみのため。フロントのゾーン目安表示は残す。
- フロントは `tooFar` 時に `tooFarToast` + 「go to art」ボタンを出す（`wd-net.js:645-650`）。

## undo（3秒取消）

- 条件: 本人・未undone・3秒以内・現在値一致（`undo.rs:101-124`）。
- 加えて **1つ前の有効履歴とprevの一致を検証する**（現状欠落=バグB6。
  Python `checkUndoPrev:452-464` と同等。undone行は無視）。
- 復元: 使用インク各1返却＋XP巻戻し（レベルダウンあり）＋報酬没収（ガチャ実装後）。
  国更新はしない（country凍結のため）。
- `prevEmpty` 時のWS配信は消去（erase）扱い（`undo.rs:196-200`）。

## 履歴

- 1セル上限 `maxHistoryPerCell`（既定0=無効、1〜200で有効化）。
  有効時のみ超過分を `ORDER BY at DESC, id DESC` で削除。無効時は残す。
- 履歴セル数の上限 `maxHistoryCells` は既定 **0（無効）**。履歴はロールバックの
  根拠のため残す。有効化すると超過分を古いセルから無言削除し、履歴表示・
  巻き戻しが効かなくなる（`place.rs:maybe_prune`、無効時はオーバーヘッドゼロ）。
- `GET /api/history` はundone除外・`beforeId` ページング・`hasMore`（実装済み）。
