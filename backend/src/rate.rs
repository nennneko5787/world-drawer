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
        .arg("1")
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
