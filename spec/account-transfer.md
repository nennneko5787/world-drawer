# アカウント引っ越し

## issue（実装済み）

- `POST /api/account/issue {password, turnstile_token?}`（Bearer）。
- パスワード長8〜128（現状ハードコード=設定化は見送り、`config.md` 参照）。
- 新規argon2（`argon2:` 接頭）で保存＋コード `XXXX-XXXX` 発行。
  旧scrypt（`scrypt$...`）は検証のみ互換（`account.rs:37-78`）。
- 対象は既存ユーザのみ。不存在は `noUser`（自動作成しない）。

## login（実装済み: 切替まで。統合は未実装→仕様は以下）

- `POST /api/account/login {code, password, turnstile_token?}`。
  成功は `{ok,token,uid,merged,profile}`。
  `merged` は統合実装まで `false` 固定、`profile:{name,color}` は付ける
  （フロント `wd-toolbar.js:296-307` が読むため。現状欠落はバグB9）。
- レート制限・Turnstileは `anti-grief.md` 参照。

## 統合（merge、実装済み）

`POST /api/account/login` に `from_token`（現端末のtoken、任意）を渡すと、
1トランザクションで統合する（Python `canvas.py:738-808` の移植）。

クライアント・help（`wd-toolbar.js:296-298` の `merged` 処理、
`i18n.js` の `h_accP`）が統合を前提にしているため、切替のみでは
「引っ越しで成長・インクが消える」ように見える。以下を1トランザクションで実装する
（Python `canvas.py:738-808` の移植）。

1. 現端末アカウント（Bearerのfrom側）と引っ越し先（code側）が別であること。
2. 総XP合算→レベル再計算（`totalEarnedFor` / `levelXpFromTotal`相当）。
3. 特殊インク合算。クールダウンは遅い方（max）を維持。
4. `history.uid` と `pixels.by` を引っ越し先uidに付け替え（両方の履歴を残す）。
5. 名前・色は引っ越し先を維持。ただし引っ越し先が初期名のまま＋
   引っ越し元が改名済みなら、引っ越し元の名前・色を引き継ぐ。
6. 国は引っ越し先が空なら引っ越し元のものを引き継ぐ（country凍結下での例外扱い）。
7. 引っ越しコード・表示設定は引っ越し先を維持。元アカウント行を削除。

## パスワード長・初期名

- `minPasswordLen=8 / maxPasswordLen=128` はコード固定（仕様、`config.md`）。
- 新規名は `ななし`・色 `#22aa66` 固定（仕様）。`lang` は受けるが初期名には使わない
  （5言語分の名前表は重みに対して効果が薄いため）。
