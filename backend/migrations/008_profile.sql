-- 008: 公開プロフィール用の登録日時。
-- usersは小規模のため短時間ロックで済む。
ALTER TABLE users ADD COLUMN IF NOT EXISTS createdAt DOUBLE PRECISION;
-- 既存行は最古の履歴から推定する (履歴なし・prune済みはNULLのまま=不明表示)。
UPDATE users SET createdAt = sub.m
FROM (SELECT uid, MIN(at) AS m FROM history GROUP BY uid) AS sub
WHERE users.uid = sub.uid AND users.createdAt IS NULL;
