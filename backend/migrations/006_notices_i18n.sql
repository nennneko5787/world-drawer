-- 006: お知らせの多言語化。title/bodyは日本語ベースのまま、
-- 翻訳はi18n JSON ({"en":{"title":"..","body":".."},...}) に保持する。
-- 未翻訳の言語は取得側が日本語ベースにフォールバックする。
ALTER TABLE notices ADD COLUMN IF NOT EXISTS i18n TEXT NOT NULL DEFAULT '{}';
