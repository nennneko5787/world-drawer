# 差分トリアージ（Python → Rust）

前回洗い出しの差分を、ユーザ判断＋フロント利用状況（`static/js/wd-*.js`）で再判定した。
結論: **仕様11件・バグ9件（全て修正済み）・未実装6件（全て実装済み）**。

## 仕様（変えない）

| # | 項目 | 根拠 |
| --- | --- | --- |
| S1 | SQLite・旧JSON・`--copy-sqlite-to-pg`廃止 | 廃止済み。Postgres専用（`main.rs:4`） |
| S2 | polling・`forceWebsocket`なし（完全バイナリWS） | 仕様。`ws_proto.rs` 維持 |
| S3 | `GET /api/debug/geo` なし | 不要 |
| S4 | Bearerのみ（body/query token廃止） | 仕様。フロントもBearerのみ送信（`wd-auth.js:27-37`） |
| S5 | オンライン一覧lean（uid/name/color/level） | 仕様。フォールバック専用（`wd-net.js:601-606`） |
| S6 | ページ・静的配信なし（Pagesの `dist/` が担当） | 仕様。`frontend/build.py` が生成 |
| S7 | WS経由placeなし（REST継続） | **クライアントは使っていない**。`place()` は `POST /api/place` のみ（`wd-net.js:630`）、WSは送受信分離 |
| S8 | socket必須・カーソル照合・同時接続制限は実装（廃止案は撤回） | `anti-grief.md`。Hubメモリ紐付けで執行。フロントは対応済み |
| S9 | country収集凍結（新規書込なし・既存表示のみ） | 収集経路（CF国・TZ表）を持ち込まない。`showCountry` 切替・履歴表示は維持 |
| S10 | IPバケツは試行時計数 | Tx後消費の複雑化に見合わない。厳しめ=保護側（`place.rs:65` TODOは本specで解消） |
| S11 | 運用ノブ固定（`config.md` の固定キー表） | 軽量化。変える必要が出たらspecから |
| S12 | マルチレプリカのWSファンアウトなし | 単一レプリカ運用（`architecture.md`） |

## バグ（直す→ `backlog.md` のP0〜P2）

| # | 項目 | 証拠 | 影響 |
| --- | --- | --- | --- |
| B1 | `DATABASE_URL`設定時に他設定喪失 → **修正済み** | `config.rs:load` はファイル読込後にURLのみ上書き |
| B2 | 履歴が常に空 → **修正済み** | `history.rs:24,41` `COALESCE(u.color,'#22aa66')` はINT列とTEXTの型不一致→実行時エラー→`unwrap_or_default`で空返却 | 履歴機能の全滅（無音） |
| B3 | rollbackのピクセル復元が失敗 → **修正済み** | `admin.rs:153-168` で正準形文字列をSMALLINT列 `t` に束縛→実行時エラー（`let _`で握り潰し）。履歴だけundone・XPだけ没収 | データ破壊（無音） |
| B4 | rollbackのXP計算が `3.0/1.5` 固定 → **修正済み** | `admin.rs:177`。config変更と乖離 | レベル巻き戻し誤差 |
| B5 | banが執行されない → **修正済み** | `place.rs` で `wd:bans` 読取＋ `banned` 返却（`rate.rs:ban_remaining`）。残: status一覧はU6 |
| B6 | undoが1つ前の履歴と突合しない → **修正済み** | `undo.rs:48-60` は形式検証のみ。Python `checkUndoPrev`（`canvas.py:452-464`）相当なし | 不正prevで任意復元 |
| B7 | placeの履歴xpがリテラル1 → **修正済み** | `place.rs:200`。`xpPerPlace` 変更と乖離 | 将来の不整合 |
| B8 | erase色が `#ffffff` 固定 → **修正済み** | `place.rs:266`。undo（`undo.rs:197`）は `cfg.background` | background変更時に不整合 |
| B9 | login応答に `merged/profile` なし → **修正済み** | フロントが読む（`wd-toolbar.js:296-307`）。現状 `token/uid` のみ（`account.rs:210`） | `merged` トースト・名前反映が動かない |

非問題の確認: undo応答の `cooldownUntil` 欠落は無害（フロント `doUndo` は読まない。
Pythonも値を変えていない `canvas.py:509-511`）。`me.hasAccount` の
`passwordHash` 判定は `transferCode` 判定と等価（issueで同時設定）。

## 未実装（作る→ `backlog.md`）

| # | 項目 | 根拠（作らないと壊れるもの） |
| --- | --- | --- |
| U1 | 報酬ガチャ → **実装済み** | config3キー追加・履歴記録・undo没収つき |
| U2 | 半径制限 `tooFar` → **実装済み** | nearPixelのみ・presence近傍は廃止のまま |
| U3 | 引っ越し統合 → **実装済み** | `from_token`・行ロック・帰属付け替え |
| U4 | OGP画像 → **実装済み** | `ogp.rs`・依存なしPNG |
| U5 | 履歴prune → **実装済み・既定無効** | ログ保全のため0=無効が既定 |
| U6 | 管理API拡張 → **実装済み** | `admin.md` の最小契約 |

設計図・スポイトは両実装ともサーバ機能なし（フロント機能）のため対象外。
