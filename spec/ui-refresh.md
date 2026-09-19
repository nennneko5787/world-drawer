# UI刷新（チャット・モーダル・管理・UIDコピー）

キャンバス内モーダルと管理ページの見た目・運用を刷新する。
位置・寸法は `static/css/modal.css`（後勝ち）が正準、`static/css/index.css` は見た目のみ。

## モーダル配置

- 共通（`.wd-modal`）は中央配置のまま。対象は
  `settingsPanel / userPanel / rankingPanel / historyPanel / chatDock / noticesPanel`
 （`wd-modal.js` が `wd-modal` 付与・排他・Esc/外側クリックで閉じる）。
- **チャット（`#chatDock`）のみ右ドロワー化**（中央から分離）:
  デスクトップは右端 `right:16px`・縦中央・`height:min(86vh,800px)`、
  `#chatList` は `flex:1` で縦に伸ばす。タブレットも右ドロワー維持
  （幅400px・84vh）。スマホのみ他と同じボトムシートだが一回り縦長（88vh）。
- **横幅**: ランキング560px・お知らせ600px・ユーザー一覧520px・設定600px
  （デスクトップ値。`modal.css` が正準）。

## 管理の統一（キャンバス → /admin）

- キャンバス内の管理モーダル（旧 `#adminPanel`）は持たない。
  `adminBtn` は `/admin` へのリンク（`a.pill`、`isAdmin` のときだけ表示）。
  `wd-admin.js` は表示切替（`refreshAdminUI`）のみ。
- オンライン一覧で管理者には各行に管理ボタン（`adminTitle`）を出し、
  `/admin?uid=<uid>` へ遷移する。`/admin` 側は `?uid=` を読み、
  認証後に自動照会する。

## 管理ページ（`/admin`）

- `help.css` とは独立。`admin.css` のみで操作コンソールとして設計する
  （変数だけ `help.css` と共有）。
- 状況カードは `presence / sockets / banned件数`＋config一行のみ。
  `topPlaceIps / topSessionIps` は仕様で返さない（`admin.md`）ため表示しない。
  代わりに `admTopRemoved` の注記を出す。
- 禁止IP表は `thead/tbody` 付きの `.admTable`。IPセルはクリックでコピー可、
  行ごとに解除ボタン。
- ユーザー詳細は `.admUser` カード＋`.admKv` 一覧で表示する:
  名前・`#uid`（コピー）・オンライン可否バッジ・Lv/XP・配置マス数・
  最終IP（コピー＋コピーボタン）・国・インク在庫。
- 認証ピル（`#admAuthLine`）は `.ok / .ng` で色分けする。
- お知らせ一覧は言語バッジ（`.admLang`・翻訳ありは `.have`）で対応状況を示す。

## 公開プロフィール（`profilePanel`・`wd-profile.js`）

- オンライン・ランキング・チャット・履歴の一覧は名前（＋国旗）のみ表示し、
  レベル・IDは常時表示しない。名前クリック（`[data-prof]`）で
  プロフィールモーダル（他パネルと排他・`wd-modal.js` 管理）を開く。
- モーダル内容: 名前・`#uid`（クリックでコピー）・Lv/XP・登録日・
  累計配置数・順位。登録日不明は「不明」表示。
  自分以外には非表示切替ボタン、管理者には `/admin?uid=` 遷移ボタンを出す。
- データは `GET /api/profile?uid=`（`api.md`「公開プロフィール」）を都度取得する。
  キャッシュは持たず、言語切替時は手元の表示値だけ描き直す。
- 自分の `#myUid` ピルは従来どおりクリックでコピー（プロフィールとは別経路）。

## UIDコピー（全部入り）

- キャンバス側: `wd-ui.js` が `[data-uid] / [data-copy]` のクリックを委任で拾い、
  `clipboard.writeText`（fallbackは `execCommand`）でコピー＋トースト
  （`uidCopied`・`copyUidHint`）。
- 対象: 自分の `#myUid`・プロフィールモーダルのID行・
  お知らせの作者UID・管理ページのユーザー詳細UID・最終IP・禁止IP。
  一覧系（オンライン・チャット・ランキング・履歴）は名前クリックで
  プロフィールを開く方式のため、一覧上にIDは出さない。
  `title` に `copyUidHint`（コピー対象）・`profileOpenHint`（名前）を付ける。
- 管理ページは `wd-ui.js` を読まないため `admin-page.js` が独自に同じ委任を持つ
  （コピー完了は `.admToast`）。ユーザー詳細のUID・最終IP、禁止IP表のIPが対象。
