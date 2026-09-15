//! 引っ越し (issue/login)。パスワードはargon2新規 + scrypt旧互換検証。

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
pub struct IssueBody {
    pub password: String,
    pub turnstile_token: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub code: String,
    pub password: String,
    pub turnstile_token: Option<String>,
}

fn hash_new(pw: &str) -> String {
    use argon2::password_hash::{PasswordHasher, SaltString};
    let salt = SaltString::generate(&mut rand::thread_rng());
    let h = argon2::Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .unwrap_or_default();
    format!("argon2:{h}")
}

fn verify(pw: &str, stored: &str) -> bool {
    if let Some(rest) = stored.strip_prefix("argon2:") {
        use argon2::password_hash::PasswordVerifier;
        let Ok(hash) = argon2::password_hash::PasswordHash::new(rest) else {
            return false;
        };
        return argon2::Argon2::default()
            .verify_password(pw.as_bytes(), &hash)
            .is_ok();
    }
    if let Some(rest) = stored.strip_prefix("scrypt$") {
        // scrypt$16384$8$1$saltHex$dkHex (旧Python互換)
        let p: Vec<&str> = rest.split('$').collect();
        if p.len() != 5 {
            return false;
        }
        let (Ok(n), Ok(r), Ok(pp)) = (
            p[0].parse::<u32>(),
            p[1].parse::<u32>(),
            p[2].parse::<u32>(),
        ) else {
            return false;
        };
        let Ok(salt) = hex::decode(p[3]) else {
            return false;
        };
        let dk = p[4];
        let params = scrypt::Params::new(
            (n as f64).log2() as u8,
            r,
            pp,
            32,
        );
        let Ok(params) = params else { return false };
        let mut out = vec![0u8; 32];
        if scrypt::scrypt(pw.as_bytes(), &salt, &params, &mut out).is_err() {
            return false;
        }
        return subtle_eq(&hex::encode(out), dk);
    }
    false
}

fn subtle_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        d |= x ^ y;
    }
    d == 0
}

async fn gate(
    state: &mut AppState,
    headers: &HeaderMap,
    peer_s: &str,
    ts: Option<&str>,
) -> Result<String, Response> {
    let nets = ip::parse_nets(&state.cfg.trusted_proxies);
    let cf = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let xff = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let client_ip = ip::resolve_client_ip(peer_s, cf, xff, &nets);
    let enforce = state.cfg.turnstile.as_ref().map(|t| t.enforce).unwrap_or(true);
    if enforce {
        let (secret, timeout) = state
            .cfg
            .turnstile
            .as_ref()
            .map(|t| (t.secret_key.clone(), t.timeout_sec))
            .unwrap_or_default();
        if !turnstile::verify(&secret, ts.unwrap_or(""), &client_ip, timeout).await {
            return Err((
                StatusCode::FORBIDDEN,
                r#"{"ok":false,"error":"turnstileRequired"}"#,
            )
                .into_response());
        }
    }
    Ok(client_ip)
}

pub async fn issue(
    State(mut state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: axum::Json<IssueBody>,
) -> Response {
    use crate::auth;
    let Ok(token) = auth::bearer(&headers) else {
        return (StatusCode::UNAUTHORIZED, r#"{"ok":false,"error":"missingToken"}"#)
            .into_response();
    };
    let peer_s = peer.ip().to_string();
    if gate(&mut state, &headers, &peer_s, body.turnstile_token.as_deref())
        .await
        .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            r#"{"ok":false,"error":"turnstileRequired"}"#,
        )
            .into_response();
    }
    if body.password.len() < 8 || body.password.len() > 128 {
        return (StatusCode::BAD_REQUEST, r#"{"ok":false,"error":"badPassword"}"#)
            .into_response();
    }
    let hash = hash_new(&body.password);
    let code = users::gen_transfer_code();
    let n = sqlx::query(
        "UPDATE users SET transferCode = $1, passwordHash = $2 WHERE token = $3",
    )
    .bind(&code)
    .bind(&hash)
    .bind(&token)
    .execute(&state.pool)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);
    if n == 0 {
        return (StatusCode::NOT_FOUND, r#"{"ok":false,"error":"noUser"}"#).into_response();
    }
    (StatusCode::OK, axum::Json(serde_json::json!({"ok": true, "code": code})))
        .into_response()
}

pub async fn login(
    State(mut state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: axum::Json<LoginBody>,
) -> Response {
    let peer_s = peer.ip().to_string();
    let gate_r = gate(&mut state, &headers, &peer_s, body.turnstile_token.as_deref()).await;
    let Ok(client_ip) = gate_r else {
        return (
            StatusCode::FORBIDDEN,
            r#"{"ok":false,"error":"turnstileRequired"}"#,
        )
            .into_response();
    };
    if !rate::allow(&mut state.redis, "login", &client_ip, 10, 600.0).await {
        return (StatusCode::TOO_MANY_REQUESTS, r#"{"ok":false,"error":"locked"}"#)
            .into_response();
    }
    let code = body.code.trim().to_uppercase();
    let row = sqlx::query(
        "SELECT token, uid, passwordHash FROM users WHERE transferCode = $1",
    )
    .bind(&code)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (StatusCode::UNAUTHORIZED, r#"{"ok":false,"error":"badLogin"}"#)
            .into_response();
    };
    use sqlx::Row;
    let token: String = r.get(0);
    let uid: String = r.get(1);
    let stored: Option<String> = r.get(2);
    if !verify(&body.password, stored.as_deref().unwrap_or("")) {
        return (StatusCode::UNAUTHORIZED, r#"{"ok":false,"error":"badLogin"}"#)
            .into_response();
    }
    (StatusCode::OK, axum::Json(serde_json::json!({"ok": true, "token": token, "uid": uid})))
        .into_response()
}
