# 荒らし対策

## ban（書込済み・執行がバグB5→仕様は以下）

- 管理は Redis `wd:bans`（hash: ip → until unix秒）。Pythonと同キー互換
  （Python `shared.py:597-630`、Rust `admin.rs:237-238`）。
- **執行点**: `POST /api/place` のユーザ判定前。残秒>0なら `banned` を返す。
  期限切れは遅延削除。Redis障害時は通す（fail-open）。
- `seconds<=0` で解除（実装済み、`admin.rs:232-235`）。
- `status` は有効ban一覧 `{ip,until}` を返す（`banList` 相当。期限切れ・壊値は掃除）。

## IP共有バケツ（実装済み・計数タイミングは仕様）

- `place`: 同一IP 60回/分（`place.rs:65-70`）。超過は `ipBusy`。
- **試行時計数**を正準とする（成功分のみ計数が理想だが、Tx後消費の複雑化に見合わない。
  厳しめに出る分には保護側に倒れるため許容。`place.rs:65` のTODOコメントは本specで解消）。
- IP解決は `trustedProxies` 経由のみヘッダ信用（`ip.rs:29-51`）。直結はpeer。

## セッション・ログイン制限（実装済み）

- `session`: 同一IP 30/h。超過は `rateLimited`（`session.rs:55`）。
- `login`: 同一IP 10回/600秒。**失敗のみ計数・成功時リセット**
  （Pythonと同方式。`rate.rs:allow_record/rate_reset`）。超過は `locked`。
- いずれもRedis zset+Lua（`rate.rs`、キー形式 `wd:rate:{name}:{key}` はPythonと同一）。
  place/sessionは試行計数、loginのみ失敗計数。`unknown` IPも1バケツに計数する（両実装同一）。
- Redis障害時は通す（fail-open、`rate.rs:37-41`）。

## Turnstile

- `session` / `account issue+login` / WS `hello` でページ表示の度に検証
  （`session.rs:37-54`、`account.rs:91-124`、`routes/mod.rs:141-161`）。
- `turnstile.enforce=false` で緊急バイパス（再起動反映）。

## socket必須・カーソル照合（実装済み）

- `requireSocketForPlace=true`（既定）で、生存WS接続のないtokenの配置を `noSocket` で拒否
  （`place.rs`）。REST直叩きの自動配置を封じる。
- 配置点からチェビシェフ距離16以内・5秒以内のカーソル到達を要求。
  不一致時は350ms待って再判定し、ダメなら `cursorMismatch`。
  （Python `canvas.py:581-608` と同値。定数は `place_logic.rs` の
  `CURSOR_FRESH_SEC/CURSOR_MAX_DIST/CURSOR_WAIT_MS`）。
- 土台はHubのメモリ紐付け（`ws.rs:bind`）: sid→token→IP＋カーソル位置。
  在席=生存のため有効期限窓は持たない（Pythonの60秒窓より単純・厳しめ）。
  単一レプリカ運用が前提（`architecture.md`）。
- フロントは両エラーを処理済み（`wd-net.js:653-656`）。

## 同時接続制限（実装済み）

- `maxSocketsPerIp`（既定64）。hello時・Turnstile検証前に判定し、
  超過は `helloOk(false, err=4 sockLimit)` で切断（siteverify増幅防止）。
  IP不明時は数えない（Python `realtime.py:160` と同等）。
- フロントはerr=4を `sockLimit` として再試行→上限到達でポーリング fallback（`wd-net.js:336`）。
