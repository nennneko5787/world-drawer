-- 007: テキストチャット。全員が読める公開チャット (ドック表示用)。
-- 送信者はuidのみ保持し、表示名・色・レベルはusersから都度解決する
-- (改名対応。historyと同方式)。最新200件のみ保持し、古い分は投稿時に整理する。
CREATE TABLE IF NOT EXISTS chat(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid TEXT NOT NULL,
  body TEXT NOT NULL,
  at DOUBLE PRECISION NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_id ON chat(id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_uid ON chat(uid);
