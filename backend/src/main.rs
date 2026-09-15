//! world-drawer backend (Rust/Axum).
//!
//! 方針 (確定仕様):
//! - Postgres専用。SQLite分岐なし。`data/world.db`はアーカイブ保持のみ。
//! - 認証は `Authorization: Bearer` のみ。body/queryのtokenは受付ない。
//! - WSはワンタイムチケット式 (`POST /api/ws-ticket` → `hello{ticket, turnstileToken}`)。
//! - ページ表示の度にTurnstile必須 (hello時検証)。
//! - `/api/*`はEdgeキャッシュBYPASS。`GET /og-image.png`のみ60sキャッシュ。

mod auth;
mod config;
mod db;
mod ip;
mod place_logic;
mod rate;
mod routes;
mod tiles;
mod turnstile;
mod users;
mod ws;

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
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

    let app = Router::new()
        .merge(routes::router(state))
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
