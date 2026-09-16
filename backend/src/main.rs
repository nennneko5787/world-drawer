//! world-drawer backend (Rust/Axum).
//!
//! 方針 (確定仕様):
//! - Postgres専用。SQLite分岐なし。`data/world.db`はアーカイブ保持のみ。
//! - 認証は `Authorization: Bearer` のみ。body/queryのtokenは受付ない。
//! - WSはワンタイムチケット式 (`POST /api/ws-ticket` → `hello{ticket, turnstileToken}`)。
//! - ページ表示の度にTurnstile必須 (hello時検証)。
//! - `/api/*`はEdgeキャッシュBYPASS。`GET /og-image.png`のみ60sキャッシュ。

mod auth;
mod color;
mod config;
mod db;
mod ip;
mod ogp;
mod place_logic;
mod rate;
mod routes;
mod tiles;
mod turnstile;
mod users;
mod ws;
mod ws_proto;

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use tower_http::compression::CompressionLayer;
use tower_http::compression::CompressionLevel;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = config::load()?;
    let pool = db::connect(&cfg).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;

    let redis = db::connect_redis(&cfg).await?;
    let listen: SocketAddr = cfg.listen.parse()?;
    let cors = cfg.cors_origins();
    let state = routes::AppState::new(cfg.clone(), pool, redis);
    // 失効チケット掃除 (未使用残骸の無制限増殖防止)
    {
        let hub = state.hub.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                hub.gc_tickets();
            }
        });
    }

    let app = Router::new()
        .merge(routes::router(state))
        // 動的JSON (MB級tiles) 向けに最速圧縮。既定q4でも1共有vCPUでは
        // 応答ごとに数百ms燃えるため。圧縮率は少し落ちるが遅延優先
        .layer(CompressionLayer::new().quality(CompressionLevel::Fastest))
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::new(Duration::from_secs(10)))
        .layer(RequestBodyLimitLayer::new(64 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin(cors)
                .allow_methods([
                    axum::http::Method::GET,
                    axum::http::Method::POST,
                    axum::http::Method::OPTIONS,
                ])
                .allow_headers([
                    axum::http::header::AUTHORIZATION,
                    axum::http::header::CONTENT_TYPE,
                ]),
        );

    let addr: SocketAddr = listen;
    tracing::info!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
