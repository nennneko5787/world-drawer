-- 003: c列そのものをINTEGER化し、ciは廃止する。
-- 002適用済み前提。ciがあればそれを、なければhex TEXTを変換する。
-- 不正値は白 (16777215 = #ffffff) に倒す。
-- ALTER TYPEはリライトを伴うためデプロイ時の短時間ロックに注意。
UPDATE pixels SET ci = ('x' || substr(c, 2, 6))::bit(24)::int
  WHERE ci IS NULL AND c ~ '^#[0-9a-fA-F]{6}$';
UPDATE pixels SET ci = 16777215 WHERE ci IS NULL;
UPDATE history SET ci = ('x' || substr(c, 2, 6))::bit(24)::int
  WHERE ci IS NULL AND c ~ '^#[0-9a-fA-F]{6}$';
UPDATE history SET ci = 16777215 WHERE ci IS NULL;
ALTER TABLE pixels ALTER COLUMN c TYPE INTEGER USING (ci);
ALTER TABLE pixels DROP COLUMN ci;
ALTER TABLE history ALTER COLUMN c TYPE INTEGER USING (ci);
ALTER TABLE history DROP COLUMN ci;
