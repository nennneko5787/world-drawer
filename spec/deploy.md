# デプロイ手順

## 前提

- バックエンドとフロントは**同時更新が必須**。WSは完全バイナリ (Text非対応) のため、
  新旧の組み合わせでは接続できない。
  - 新サーバ + 旧フロント (ticketをTEXT送信) → 無言切断・1006・helloOkなし
  - 旧サーバ + 新フロント (バイナリhello) → 解釈不能で切断
- どちらを更新したかは以下で確認する。
  - サーバ: 起動ログに `ws drop:` / `ws hello ok` が出れば新バイナリ。
  - フロント: 配信JSの `helloBin` が `ArrayBuffer` を返すこと。DevToolsのWS欄で
    送信メッセージがバイナリ表示になれば新。ticket文字列がTEXT表示なら旧。

## バックエンド (Linux)

```bash
cd /opt/world-drawer && git pull
cd backend && cargo build --release
sudo systemctl restart world-drawer-backend
journalctl -u world-drawer-backend -f   # ws hello ok / ws drop: を確認
```

## フロント (Pages)

```bash
WD_API=https://本物のAPIホスト WD_WS=wss://本物のAPIホスト/ws \
  TURNSTILE_SITE_KEY=... python frontend/build.py
# dist/ をPagesにデプロイ。ページソースの ?v= ハッシュ変化と
# <meta name="wd-ws"> が本物URLであることを確認
```

## WS疎通の切り分け表

| サーバログ | ブラウザ | 意味 |
| --- | --- | --- |
| `ws hello ok` | 即1006 | プロキシのidle切断・下流の問題 |
| `ws drop: bad-ticket` | 即1006 | チケット失効・二重use |
| `ws drop: turnstile` | 即1006 (+3回後トースト) | secretKey不一致・siteverify不通 |
| `ws drop: no-user` | 即1006 | token不一致 (`wd_token` 確認) |
| `ws drop: no-hello` / `bad-hello` | 即1006 | **旧フロント** またはプロキシ破損 |
| 何も出ない | 即1006 | Axum未到達 (URL誤り・プロキシでWS不通) |
