# world-drawer 仕様（spec駆動開発）

Rustバックエンド（`backend/`）＋ 静的フロント（`frontend/build.py` → `dist/`）を正とする。
Python実装（`app/`・`main.py`）は**レガシー凍結**。参照専用で、機能追加・修正はしない。

## ステータス定義

| 区分 | 意味 |
| --- | --- |
| 仕様 | 意図した差分・廃止。このまま変えない |
| バグ | 意図せず仕様から外れている。直す |
| 未実装 | 仕様上必要だが未移植。作る |

## ファイル一覧

| ファイル | 内容 |
| --- | --- |
| `architecture.md` | 全体構成・プロセス・データストア・凍結宣言 |
| `api.md` | REST契約（正準）。全エンドポイント・認証・エラーコード |
| `ws-protocol.md` | バイナリWS・チケット・購読タイル配信 |
| `game-rules.md` | クールダウン・XP・インク・ガチャ・半径・undo・履歴 |
| `anti-grief.md` | ban・IPバケツ・レート制限・Turnstileと執行点 |
| `account-transfer.md` | 引っ越しコード発行・ログイン・統合 |
| `admin.md` | 管理APIの最小契約（管理ページ対応） |
| `config.md` | configキー表（有効 / 固定 / 廃止） |
| `og-image.md` | OGP画像の軽量仕様 |
| `gap-analysis.md` | Python差分のトリアージ（仕様 / バグ / 未実装、証拠付き） |
| `backlog.md` | 優先度付き実装バックログ（受け入れ条件付き） |
| `deploy.md` | 再展開手順・WS疎通切り分け表 |

## 運用ルール

1. 動作を変える前に該当specを更新し、このREADMEの日付を進める。
2. `バグ`はspec修正なしで直してよい（specが正・実装が誤りのため）。
3. `未実装`はspecを先に確定し、`backlog.md`の受け入れ条件を満たしてから閉じる。
4. エンドポイント・WSフレーム・DB列を変える変更は `api.md` / `ws-protocol.md` / `architecture.md` の同時更新が必須。
5. フロント（`static/js/wd-*.js`）が読むフィールドを削る変更は禁止。足す分には可。

最終更新: 2026-09-18（お知らせ機能・管理UID制。U7・U8実装）
