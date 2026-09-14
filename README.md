# world-drawer

ブラウザで遊べる無限キャンバスのお絵かきボード（r/place 風）。全員で1つの世界に1マスずつ描画し、リアルタイムに同期されます。

- 無限キャンバス（負座標OK）＋グリッド・原点軸・座標表示
- 1マス配置ごとにクールダウン（レベルで短縮）・経験値・レベルアップ
- 特殊インク（発光 / 虹色 / ゴースト）のガチャ、3秒以内の取り消し
- 名前付きカーソル・オンライン一覧・履歴・設計図・スポイト・カスタムカラーピッカー
- アカウント引っ越し（コード＋パスワード）・荒らし対策・ライト/ダーク/自動テーマ
- 日本語 / English / 한국어 / 简体中文 / 繁體中文 の5言語対応

## 必要要件

- Python 3.13 以上
- [uv](https://docs.astral.sh/uv/)（依存管理・起動に使用）

## セットアップ

```powershell
uv sync
```

初回起動時に `data/world.db`（SQLite）が自動作成されます。旧JSON保存（`data/canvas.json` 等）があれば初回のみ自動取り込みします。

## 起動

```powershell
# 開発・手元確認用 (http://127.0.0.1:8000)
python main.py

# 本番用 (http://127.0.0.1:5787)
uv run uvicorn main:app --port 5787
```

ヘルプは `/help` で表示されます。

## 設定

`config.jsonc`（コメント付きJSON。末尾カンマ可）でゲームバランスを変更できます。変更はサーバー再起動後に反映されます。不正な値・不明なキーは警告のうえ既定値を使います。

| 項目 | 内容 |
| --- | --- |
| `cooldownSec` / `minCooldown` / `cooldownDecay` | Lv1の秒数・下限・レベルごとの倍率 |
| `xpPerPlace` / `xpBase` / `xpPow` | 配置ごとの経験値・必要経験値の係数と指数（レベル上限なし） |
| `background` / `coordLimit` / `maxNameLen` / `maxBboxPixels` | 背景色・座標上限・名前の長さ・視野取得の上限 |
| `rewardChance` / `rewardMin` / `rewardMax` | 特殊インクの当選確率と付与量 |
| `maxHistoryPerCell` / `maxHistoryCells` | 履歴の保持上限 |
| `minPasswordLen` / `maxPasswordLen` / `sessionPerHour` / `loginMaxFails` / `loginLockSec` | アカウント関連の制限 |
| `placePerMinPerIp` / `placeRadius` / `trustedLevel` | 荒らし対策（IP共有上限・低レベルの配置半径・半径制限が外れるレベル） |

## 構成

```text
main.py              配線のみ（FastAPI + Socket.IO）
app/routes/          ページ・REST API・静的ファイル配信（gzip/brotli圧縮＋キャッシュ）
app/services/        データベース・ユーザー・キャンバス・presence・Socket.IO
app/objects/         設定・Pydanticモデル
pages/               index.html・help.html
static/              css・js（テーマ・i18n・メイン）
config.jsonc         ゲームバランス設定
data/                SQLite本体（Git管理外）
```

配置・クールダウン・所持インク・配置半径の判定はすべてサーバー側で行います。クライアント側の表示（クールダウン残量・境界線など）は目安です。

## 開発

```powershell
uv run ruff check .      # Lint
uv run ruff format .     # 整形
uv run ty check          # 型チェック
```

JSの構文確認は `node --check` で行えます（対象: `static/js/wd-*.js`）。
フロントは機能別の classic script 分割（`wd-state` → … → `wd-main` の順に読込、トップレベルスコープ共有）です。
後続ファイルの関数をトップレベルで直接参照せず、実行時解決（`(...a) => f(...a)`）にしてください。

## 注意

- `data/` 配下（描画内容・ユーザー情報）はリポジトリに含めません
- 本番運用時はバックアップを推奨します

## 公開例：Cloudflare Tunnel

リバースプロキシなしで公開する場合の例です。`cloudflared` が自ホストから出るため、
既定の `trustedProxies`（`127.0.0.1`・`::1`）のままでクライアントIPを取得できます。

```powershell
cloudflared tunnel --url http://127.0.0.1:5787
```

- 接続元IPは `CF-Connecting-IP` ヘッダから取得します
- 国旗は最終接続国の `CF-IPCountry` から自動設定されます（一覧・履歴に表示、アカウントパネルで表示/非表示のみ切替可）
- `trustedProxies` に含まれる相手からの接続でのみ `CF-Connecting-IP` /
  `X-Forwarded-For` を信用し、直結リクエストのヘッダは偽装可能なため無視します
- 別構成のリバースプロキシを使う場合は、その出口IP/CIDRを `trustedProxies`
  （`config.jsonc`）に追加してください
