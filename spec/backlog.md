# バックログ

## P0（ゲーム成立・データ保全。即着手）

- [x] **B1 config喪失の修正** — 修正済み（URLのみ上書き）。
- [x] **B2 履歴空の修正** — 修正済み（COALESCE型修正）。
- [x] **B3 rollback復元の修正** — 修正済み（bitmask数値束縛）。
- [x] **B5 ban執行** — 修正済み（`place.rs` + `rate.rs:ban_remaining`）。
- [x] **U1 報酬ガチャ** — 実装済み（config3キー・履歴記録・undo没収つき）。

## P1（荒らし対応・ admin・運用）

- [x] **U2 半径制限** — 実装済み（nearPixelのみ・COUNT不使用）。
- [x] **B6 undo突合強化** — 実装済み（older有効履歴との突合）。
- [x] **B4 rollbackのconfig値使用** — 修正済み。
- [x] **U3 引っ越し統合** — 実装済み（`from_token`・行ロック・帰属付け替え）。
- [x] **U6 管理API拡張** — 実装済み（banned一覧・lookup拡張・`noteLastIp`・events平坦化）。
- [x] **U4 OGP画像** — 実装済み（`ogp.rs`・依存なしPNG・60秒cache）。

## P2（整合・小粒）

- [x] **B7/B8** — 修正済み（履歴xp・erase色のconfig準拠化）。
- [x] **B9** — 修正済み（login応答に `merged:false` + `profile` を追加）。
- [x] **U5 履歴prune** — 実装済みだが既定無効（履歴・rollback保全のため）。
- [ ] **フロントdead code整理** — `noSocket`/`cursorMismatch` 分岐・
  `requireSocketForPlace` 表示の削除（S8の確定後）。
- [ ] **初期名の言語対応** — `lang`→初期名マップ（やる場合のみ。既定は `ななし` 固定）。

## やらない（仕様として確定）

`gap-analysis.md` のS1〜S12（S8は撤回→実装済み）。蒸し返す場合はspec更新から。
