-- 004: 残りの文字列列を数値化する。
-- pixels/historyはリライトを伴うためデプロイ時の短時間ロックに注意。
-- usersは小規模。
--
-- t: TEXT → SMALLINT (ink bitmask。ws_protoと一致:
--     chalk=1 ghost=2 glow=4 rainbow=8 shield=16 normal=0 erase=32)
-- coats: INTEGER → SMALLINT (0〜5)
-- history.undone: INTEGER → BOOLEAN
-- users.color: TEXT → INTEGER (0xRRGGBB。不正値は既定色2245734=#22aa66)

-- pixels
ALTER TABLE pixels ALTER COLUMN t DROP DEFAULT;
ALTER TABLE pixels
  ALTER COLUMN t TYPE SMALLINT USING (
    CASE WHEN t = 'normal' THEN 0
         WHEN t = 'erase' THEN 32
         ELSE (CASE WHEN t LIKE '%chalk%' THEN 1 ELSE 0 END
             + CASE WHEN t LIKE '%ghost%' THEN 2 ELSE 0 END
             + CASE WHEN t LIKE '%glow%' THEN 4 ELSE 0 END
             + CASE WHEN t LIKE '%rainbow%' THEN 8 ELSE 0 END
             + CASE WHEN t LIKE '%shield%' THEN 16 ELSE 0 END)
    END),
  ALTER COLUMN coats TYPE SMALLINT USING (coats::smallint);
ALTER TABLE pixels ALTER COLUMN t SET DEFAULT 0;

-- history
ALTER TABLE history ALTER COLUMN undone DROP DEFAULT;
ALTER TABLE history
  ALTER COLUMN t TYPE SMALLINT USING (
    CASE WHEN t = 'normal' THEN 0
         WHEN t = 'erase' THEN 32
         ELSE (CASE WHEN t LIKE '%chalk%' THEN 1 ELSE 0 END
             + CASE WHEN t LIKE '%ghost%' THEN 2 ELSE 0 END
             + CASE WHEN t LIKE '%glow%' THEN 4 ELSE 0 END
             + CASE WHEN t LIKE '%rainbow%' THEN 8 ELSE 0 END
             + CASE WHEN t LIKE '%shield%' THEN 16 ELSE 0 END)
    END),
  ALTER COLUMN undone TYPE BOOLEAN USING (undone <> 0);
ALTER TABLE history ALTER COLUMN undone SET DEFAULT false;

-- users
ALTER TABLE users ALTER COLUMN color TYPE INTEGER USING (
  CASE WHEN color ~ '^#[0-9a-fA-F]{6}$'
       THEN ('x' || substr(color, 2, 6))::bit(24)::int
       ELSE 2245734 END);
