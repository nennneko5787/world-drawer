-- 009: チャット返信。返信先メッセージIDを保持する。
-- 整理削除 (最新200件保持) で参照先が消えるため外部キー制約は付けない。
-- 参照先欠落時はクライアントが「削除されたメッセージ」表示に倒す。
ALTER TABLE chat ADD COLUMN IF NOT EXISTS replyTo BIGINT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_replyTo ON chat(replyTo);
