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
| 8 | chat | S→C 可変 | `[8, id8, at8, uid6, namelen u8, name, r,g,b, level u16, bodylen u16, body]`（凍結。拡張しない） |
| 9 | time | S→C 9B | `[9, now8 f64]`（epoch秒。1分毎の時刻同期用） |
| 10 | chatReply | S→C 可変 | `[10, id8, at8, uid6, namelen u8, name, r,g,b, level u16, bodylen u16, body, replyId8, ruid6, rnamelen u8, rname, rbodylen u16, rbody]`（旧クライアントは未知kindとして無視） |

uidは先頭6B（`push_uid`）。nameはUTF-8・最大200Bで文字境界丸め。
chatのbodyはUTF-8（200文字制限済みのため最大でも1KB未満）。

## カーソル表示（仕様）

- 受信側の表示に無操作失効はない。最終更新からの経過時間では消さない
  （`wd-render.js`）。消えるのは `leave`・ブロック・設定OFF・視野外のみ。
- 送信側の間引き（同一セル800ms・全体cursorMinMs）と中継間引き
  （同一セルまたは200ms未満は中継せず記録のみ）は維持する。

## 時刻同期（仕様）

- サーバはhello成功直後＋60秒毎にkind=9（`ws_proto.rs:time_bin`）を送る。
  精度はミリ秒。送れなければ次回で復旧する（接続維持を優先）。
- クライアントは仮想サーバ時計を持つ（`wd-state.js:serverNowMs`）。
  同期間は単調時計（`performance.now`）でローカルと同じ増え方をし、
  受信のたび補正する。WS未接続時はREST学習値（`applyLevelData`）に落とす。
- クールダウンの表示・ゲートとundoカウントダウンはこの時計で計算する。

## チャット受信（仕様）

- 送信は `POST /api/chat` のみ。WSのC→Sにchatは足さない（配置と同方式）。
- サーバーは投稿成功時にkind=8（通常）またはkind=10（返信・引用付き）を
  `broadcast_all`（送信者自身にも届く）。kind=8は凍結し、返信はkind=10で送る
  （旧クライアントの厳密長チェックを壊さないため）。旧クライアントは
  kind=10を未知kindとして無視する。
  クライアントはid重複排除のうえドックへ追記する。
- クライアント実装は `static/js/wd-chat.js`（受信入口 `onChatBinMsg`・
  `onChatReplyBinMsg`）+ `static/js/wd-net.js:onWsBin` のkind=8/10分岐。

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
