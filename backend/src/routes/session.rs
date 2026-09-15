use crate::ip;
use crate::rate;
use crate::routes::AppState;
use crate::turnstile;
use crate::users;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::net::SocketAddr;

#[derive(Deserialize)]
pub struct CreateBody {
    pub turnstile_token: String,
    pub lang: Option<String>,
}

/// セッション発行。Turnstile必須 (ページ表示の度)。
pub async fn create(
    State(mut state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: axum::Json<CreateBody>,
) -> Response {
    let nets = ip::parse_nets(&state.cfg.trusted_proxies);
    let peer_s = peer.ip().to_string();
    let cf = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let xff = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let client_ip = ip::resolve_client_ip(&peer_s, cf, xff, &nets);

    // Turnstile必須
    let enforce = state.cfg.turnstile.as_ref().map(|t| t.enforce).unwrap_or(true);
    if enforce {
        let (secret, timeout) = state
            .cfg
            .turnstile
            .as_ref()
            .map(|t| (t.secret_key.clone(), t.timeout_sec))
            .unwrap_or_default();
        if !turnstile::verify(&secret, body.turnstile_token.trim(), &client_ip, timeout).await
        {
            return (
                StatusCode::FORBIDDEN,
                r#"{"ok":false,"error":"turnstileRequired"}"#,
            )
                .into_response();
        }
    }
    if !rate::allow(&mut state.redis, "session", &client_ip, 30, 3600.0).await {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            r#"{"ok":false,"error":"rateLimited"}"#,
        )
            .into_response();
    }
    // 3回衝突リトライ
    for _ in 0..3 {
        let token = format!("wd_{}", uuid::Uuid::new_v4().simple());
        let uid = users::gen_uid();
        let name = "ななし";
        let color = 0x22aa66;
        let inv = serde_json::json!({"glow":0,"rainbow":0,"ghost":0,"chalk":0,"shield":0});
        let r = sqlx::query(
            "INSERT INTO users(token, uid, name, color, inventory) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT DO NOTHING",
        )
        .bind(&token)
        .bind(&uid)
        .bind(name)
        .bind(color)
        .bind(inv.to_string())
        .execute(&state.pool)
        .await;
        match r {
            Ok(done) if done.rows_affected() == 1 => {
                let body = serde_json::json!({
                    "ok": true, "token": token, "uid": uid,
                    "profile": {"name": name, "color": crate::color::int_to_hex(color)},
                    "inventory": {"glow":0,"rainbow":0,"ghost":0,"chalk":0,"shield":0},
                    "cooldownUntil": 0.0,
                    "cooldown": state.cfg.cooldown_sec,
                    "level": 1, "xp": 0,
                    "xpNeeded": users::xp_needed_for_level(
                        1, state.cfg.xp_base, state.cfg.xp_pow),
                    "hasAccount": false, "country": null, "showCountry": true,
                });
                return (StatusCode::OK, axum::Json(body)).into_response();
            }
            Ok(_) => continue,
            Err(_) => continue,
        }
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        r#"{"ok":false,"error":"busy"}"#,
    )
        .into_response()
}
