//! DB接続 (Postgres専用) + Redis接続。

use crate::config::Config;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

pub async fn connect(cfg: &Config) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(30)
        .connect(&cfg.database_url)
        .await?;
    Ok(pool)
}

pub async fn connect_redis(cfg: &Config) -> anyhow::Result<redis::aio::ConnectionManager> {
    let client = redis::Client::open(cfg.redis_url.clone())?;
    let mgr = redis::aio::ConnectionManager::new(client).await?;
    Ok(mgr)
}
