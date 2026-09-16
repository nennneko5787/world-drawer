# WSバイナリプロトコル

素WebSocketのBinaryフレームのみ。Textフレームは送受信とも使わない
（`backend/src/ws_proto.rs:1-21`、`backend/src/routes/mod.rs:220`）。
JSON比で pixel約110B→20B、cursor約90B→15Bのためこの形式を維持する。

## フレーム（kind先頭1B）

| kind | 名前 | 方向 | 形式 |
| --- | --- | --- | --- |
| 1 | pixel | S→C 20B | `[1, x4, y4, r,g,b, ink, coats, uid6]` |
| 2 | cursor | 双方向 15B | `[2, x4, y4, uid6]`（C→S時はuid部無視・認証済みuidを使用） |
| 3 | leave | S→C 7B | `[3, uid6]` |
| 4 | hello | C→S 可変 | `[4, tlen u16, ticket, slen u16, turnstileToken]` |
| 5 | watch | C→S 可変 | `[5, count u16, (tx i32, ty i32)×count]`（上限512） |
| 6 | helloOk | S→C 9B | `[6, ok, err, uid6]`（err: 0 none / 1 badTicket / 2 turnstile / 3 noUser / 4 sockLimit） |
| 7 | join | S→C 可変 | `[7, uid6, namelen u8, name, r,g,b, level u16]` |

uidは先頭6B（`push_uid`）。nameはUTF-8・最大200Bで文字境界丸め。

## 接続フロー

1. クライアントは `POST /api/ws-ticket`（Bearer）で使い切りチケット取得（30秒有効）。
2. WS接続→10秒以内にhello送信。チケット消費→Turnstile検証（`enforce`時）→
   既存ユーザ解決（新規作成しない）→ `helloOk(true)`。
3. 以降 `watch` で購読タイル（128セル単位、`tiles.rs:8`）を更新。
   サーバは該当タイル宛のpixel/cursorだけを送る。`join`/`leave` のみ全体配信。
4. 切断時は `leave` を全体配信。backpressure時は落とす（全体を道連れにしない、`ws.rs:67-78`）。
5. 二重起動防止・hello前レート制限（同一IP 5/分）はクライアント・サーバ双方で維持する。

## クライアント実装の対応

`static/js/wd-net.js:297-470`（接続・hello・watch・cursor・再接続）。
`fetchViewport` が視野タイルを `watch` 通知しつつ `GET /api/tiles` で差分取得する。
