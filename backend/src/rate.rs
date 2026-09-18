//! レート制限 (Valkey zset + Lua、Python shared.rateAllowの移植)。
//! Redis障害時はfail-open (可用性優先)。

const LUA: &str = r#"
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[3]) then return 0 end
if ARGV[6] == '1' then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
end
return 1
"#;

pub async fn allow(
    redis: &mut redis::aio::ConnectionManager,
    name: &str,
    key: &str,
    limit: i64,
    window_sec: f64,
) -> bool {
    allow_record(redis, name, key, limit, window_sec, true).await
}

/// 枠内なら true。record=falseは照会のみで計数しない
/// (Python rateAllowのrecord旗相当。ログインの失敗計数に使う)
pub async fn allow_record(
    redis: &mut redis::aio::ConnectionManager,
    name: &str,
    key: &str,
    limit: i64,
    window_sec: f64,
    record: bool,
) -> bool {
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let member = format!("{:.3}:{}", now, &uuid::Uuid::new_v4().to_string()[..8]);
    let rkey = format!("wd:rate:{name}:{key}");
    let script = redis::Script::new(LUA);
    let res: Result<i32, _> = script
        .key(rkey)
        .arg(now - window_sec)
        .arg(now)
        .arg(limit)
        .arg(member)
        .arg(window_sec as i64 + 120)
        .arg(if record { "1" } else { "0" })
        .invoke_async(redis)
        .await;
    match res {
        Ok(v) => v == 1,
        Err(e) => {
            tracing::warn!("rateAllow degraded: {e}");
            true
        }
    }
}

/// 枠切れ時に次に試行可能になるまでの残り秒。枠内・不明時は 0.0。
/// window内最古スコア + window - now (Python rateRetryAfter相当)。
/// Redis障害時は 0.0 (allow が fail-open のため)。
pub async fn retry_after(
    redis: &mut redis::aio::ConnectionManager,
    name: &str,
    key: &str,
    window_sec: f64,
) -> f64 {
    if key.is_empty() || key == "unknown" {
        return 0.0;
    }
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let rkey = format!("wd:rate:{name}:{key}");
    let rows: Result<Vec<(String, f64)>, _> = redis::cmd("ZRANGEBYSCORE")
        .arg(&rkey)
        .arg(now - window_sec)
        .arg("+inf")
        .arg("WITHSCORES")
        .arg("LIMIT")
        .arg(0)
        .arg(1)
        .query_async(redis)
        .await;
    match rows {
        Ok(v) => {
            let Some((_, oldest)) = v.into_iter().next() else {
                return 0.0;
            };
            (oldest + window_sec - now).max(0.0)
        }
        Err(e) => {
            tracing::warn!("rateRetryAfter degraded: {e}");
            0.0
        }
    }
}

/// バケツ消去 (ログイン成功時のロック解除用。Python rateReset相当)
pub async fn rate_reset(redis: &mut redis::aio::ConnectionManager, name: &str, key: &str) {
    use redis::AsyncCommands;
    let _: Result<(), _> = redis.del(format!("wd:rate:{name}:{key}")).await;
}

/// ban残秒 (`wd:bans` hash: ip -> until unix秒。Python banRemaining相当)。
/// 期限切れ・壊値は遅延削除。Redis障害時は通す (fail-open)。
pub async fn ban_remaining(
    redis: &mut redis::aio::ConnectionManager,
    ip: &str,
) -> f64 {
    use redis::AsyncCommands;
    if ip.is_empty() || ip == "unknown" {
        return 0.0;
    }
    let raw: Option<String> = redis.hget("wd:bans", ip).await.unwrap_or(None);
    let Some(s) = raw else {
        return 0.0;
    };
    let until: Option<f64> = s.trim().parse().ok();
    let Some(until) = until else {
        let _: Result<(), _> = redis.hdel("wd:bans", ip).await;
        return 0.0;
    };
    let now = chrono::Utc::now().timestamp() as f64;
    if until <= now {
        let _: Result<(), _> = redis.hdel("wd:bans", ip).await;
        return 0.0;
    }
    until - now
}

/// 最終IP記録 (荒らし特定用。`wd:lastip` hash: token -> `ip|ts`)。
/// unknownは捨てる。件数はユーザー数上限のため掃除しない。
pub async fn note_last_ip(
    redis: &mut redis::aio::ConnectionManager,
    token: &str,
    ip: &str,
) {
    use redis::AsyncCommands;
    if token.is_empty() || ip.is_empty() || ip == "unknown" {
        return;
    }
    let now = chrono::Utc::now().timestamp() as f64;
    let _: Result<(), _> = redis
        .hset("wd:lastip", token, format!("{ip}|{now}"))
        .await;
}

/// 最終IP取得。なければNone。
pub async fn last_ip(
    redis: &mut redis::aio::ConnectionManager,
    token: &str,
) -> Option<String> {
    use redis::AsyncCommands;
    let raw: Option<String> = redis.hget("wd:lastip", token).await.unwrap_or(None);
    raw?.split('|').next().map(|s| s.to_string())
}
