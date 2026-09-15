use crate::auth;
use crate::routes::AppState;
use crate::users;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;

/// 自分取得。Bearerのみ。query/body tokenは受付ない。
pub async fn me(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let Ok(token) = auth::bearer(&headers) else {
        return (StatusCode::UNAUTHORIZED, r#"{"ok":false,"error":"missingToken"}"#)
            .into_response();
    };
    let row = sqlx::query(
        "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp,
                transferCode, passwordHash, country, showCountry
         FROM users WHERE token = $1",
    )
    .bind(&token)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (StatusCode::NOT_FOUND, r#"{"ok":false,"error":"noUser"}"#).into_response();
    };
    use sqlx::Row;
    let inv: String = r.get(4);
    let keys: Vec<String> = vec![
        "glow".into(),
        "rainbow".into(),
        "ghost".into(),
        "chalk".into(),
        "shield".into(),
    ];
    let _ = peer;
    let level = users::clamp_level(r.get::<i32, _>(6) as i64);
    let body = serde_json::json!({
        "token": token,
        "uid": r.get::<String, _>(1),
        "profile": {"name": r.get::<String, _>(2), "color": crate::color::int_to_hex(r.get::<i32, _>(3))},
        "inventory": users::parse_inventory(&inv, &keys),
        "cooldownUntil": r.get::<f64, _>(5),
        "cooldown": users::cooldown_for_level(
            level, state.cfg.cooldown_sec, state.cfg.min_cooldown, state.cfg.cooldown_decay),
        "level": level,
        "xp": r.get::<i32, _>(7) as i64,
        "xpNeeded": users::xp_needed_for_level(level, state.cfg.xp_base, state.cfg.xp_pow),
        "hasAccount": r.get::<Option<String>, _>(9).is_some(),
        "country": r.get::<Option<String>, _>(10),
        "showCountry": r.get::<i32, _>(11) != 0,
    });
    (StatusCode::OK, axum::Json(body)).into_response()
}
