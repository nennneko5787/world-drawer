-- 002: カラーint化 phase 1 (dual-write 準備)。
-- ADD COLUMN nullable のみ。Postgres 11+ ではメタデータ変更のみで
-- テーブルリライトなし・ロック一瞬。backfill はしない (新規書込が
-- dual-write し、ホットセルから自然に埋まる。cold は c フォールバック)。
-- 全行埋まりを確認後の別deployで c を落として初めて節約になる。
ALTER TABLE pixels ADD COLUMN IF NOT EXISTS ci INTEGER;
ALTER TABLE history ADD COLUMN IF NOT EXISTS ci INTEGER;
