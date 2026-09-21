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
    /// 現端末のtoken (統合用。空・不一致・不存在なら切替のみ)
    #[serde(default)]
    pub from_token: Option<String>,
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
    peer: &SocketAddr,
    ts: Option<&str>,
) -> Result<String, Response> {
    let nets = ip::parse_nets(&state.cfg.trusted_proxies);
    let client_ip = ip::client_ip_from_headers(headers, peer, &nets);
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
    if gate(&mut state, &headers, &peer, body.turnstile_token.as_deref())
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
    let gate_r = gate(&mut state, &headers, &peer, body.turnstile_token.as_deref()).await;
    let Ok(client_ip) = gate_r else {
        return (
            StatusCode::FORBIDDEN,
            r#"{"ok":false,"error":"turnstileRequired"}"#,
        )
            .into_response();
    };
    if !rate::allow_record(&mut state.redis, "login", &client_ip, 10, 600.0, false).await
    {
        return (StatusCode::TOO_MANY_REQUESTS, r#"{"ok":false,"error":"locked"}"#)
            .into_response();
    }
    let code = body.code.trim().to_uppercase();
    let row = sqlx::query(
        "SELECT passwordHash FROM users WHERE transferCode = $1",
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
    let stored: Option<String> = r.get(0);
    if !verify(&body.password, stored.as_deref().unwrap_or("")) {
        // 失敗のみ計数。成功時は下でリセット (Pythonと同方式)
        let _ = rate::allow_record(&mut state.redis, "login", &client_ip, 10, 600.0, true).await;
        return (StatusCode::UNAUTHORIZED, r#"{"ok":false,"error":"badLogin"}"#)
            .into_response();
    }
    rate::rate_reset(&mut state.redis, "login", &client_ip).await;
    // 統合 (現端末のアカウントを引っ越し先に合体。account-transfer.md)。
    // 行ロックで同時統合と直列化する
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                r#"{"ok":false,"error":"busy"}"#,
            )
                .into_response()
        }
    };
    let dst = sqlx::query(
        "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp, country, createdAt
         FROM users WHERE transferCode = $1 FOR UPDATE",
    )
    .bind(&code)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    let Some(d) = dst else {
        return (StatusCode::UNAUTHORIZED, r#"{"ok":false,"error":"badLogin"}"#)
            .into_response();
    };
    let dst_token: String = d.get(0);
    let dst_uid: String = d.get(1);
    let mut name: String = d.get(2);
    let mut color: String = crate::color::int_to_hex(d.get::<i32, _>(3));
    let mut merged = false;
    let from = body.from_token.clone().unwrap_or_default().trim().to_string();
    if !from.is_empty() && from != dst_token {
        let src = sqlx::query(
            "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp, country, createdAt
             FROM users WHERE token = $1 FOR UPDATE",
        )
        .bind(&from)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None);
        if let Some(s) = src {
            let src_uid: String = s.get(1);
            if src_uid == dst_uid {
                // uidが同じでもトークンが違えば旧行だけ消す
                let _ = sqlx::query("DELETE FROM users WHERE token = $1")
                    .bind(&from)
                    .execute(&mut *tx)
                    .await;
            } else {
                let keys = ["glow", "rainbow", "ghost", "chalk", "shield"]
                    .iter()
                    .map(|k| k.to_string())
                    .collect::<Vec<_>>();
                let total = users::total_earned(
                    d.get::<i32, _>(6) as i64,
                    d.get::<i32, _>(7) as i64,
                    state.cfg.xp_base,
                    state.cfg.xp_pow,
                ) + users::total_earned(
                    s.get::<i32, _>(6) as i64,
                    s.get::<i32, _>(7) as i64,
                    state.cfg.xp_base,
                    state.cfg.xp_pow,
                );
                let (lv, xp) =
                    users::level_xp_from_total(total, state.cfg.xp_base, state.cfg.xp_pow);
                let mut dinv = users::parse_inventory(&d.get::<String, _>(4), &keys);
                let sinv = users::parse_inventory(&s.get::<String, _>(4), &keys);
                for k in &keys {
                    *dinv.entry(k.clone()).or_insert(0) += sinv.get(k).copied().unwrap_or(0);
                }
                let cd = d.get::<f64, _>(5).max(s.get::<f64, _>(5));
                let country: Option<String> =
                    d.get::<Option<String>, _>(8).or(s.get::<Option<String>, _>(8));
                // 登録日は古い方を残す (両方なければNULLのまま)
                let created: Option<f64> = match (
                    d.get::<Option<f64>, _>(9),
                    s.get::<Option<f64>, _>(9),
                ) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a @ Some(_), None) => a,
                    (None, b) => b,
                };
                // 名前・色は引っ越し先維持。先が初期名のまま＋元が改名済みなら元を採用
                const DEFAULTS: [&str; 5] = ["ななし", "Anon", "익명", "无名", "無名"];
                let mut new_name = name.clone();
                let mut new_color = color.clone();
                let src_name: String = s.get::<String, _>(2).trim().to_string();
                if DEFAULTS.contains(&new_name.as_str())
                    && !src_name.is_empty()
                    && !DEFAULTS.contains(&src_name.as_str())
                {
                    new_name = users::clean_name(&src_name, 20, "ななし");
                    new_color = users::clean_color(
                        &crate::color::int_to_hex(s.get::<i32, _>(3)),
                        &new_color,
                    );
                    // 予約名 (管理者専用) の引き継ぎは管理者のみ。
                    // 非管理者は引っ越し先の現行名・色を維持する (拒否すると
                    // 引っ越し不能になるため。account-transfer.md)。
                    if state.cfg.is_reserved_name(&new_name)
                        && !state.cfg.is_admin_uid(&dst_uid)
                    {
                        new_name = name.clone();
                        new_color = color.clone();
                    }
                }
                let _ = sqlx::query(
                    "UPDATE users SET inventory = $1, cooldownUntil = $2, level = $3,
                     xp = $4, country = $5, name = $6, color = $7, createdAt = $8 WHERE token = $9",
                )
                .bind(serde_json::to_string(&dinv).unwrap_or_default())
                .bind(cd)
                .bind(lv)
                .bind(xp)
                .bind(country)
                .bind(&new_name)
                .bind(crate::color::hex_to_int(&new_color).unwrap_or(0x22aa66))
                .bind(created)
                .bind(&dst_token)
                .execute(&mut *tx)
                .await;
                // 帰属の付け替え (両方の履歴を残す)
                let _ = sqlx::query("UPDATE history SET uid = $1 WHERE uid = $2")
                    .bind(&dst_uid)
                    .bind(&src_uid)
                    .execute(&mut *tx)
                    .await;
                let _ = sqlx::query("UPDATE pixels SET by = $1 WHERE by = $2")
                    .bind(&dst_uid)
                    .bind(&src_uid)
                    .execute(&mut *tx)
                    .await;
                let _ = sqlx::query("DELETE FROM users WHERE token = $1")
                    .bind(&from)
                    .execute(&mut *tx)
                    .await;
                name = new_name;
                color = new_color;
                merged = true;
            }
        }
    }
    if tx.commit().await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"ok":false,"error":"busy"}"#,
        )
            .into_response();
    }
    if merged {
        state.hub.forget_token(&from);
    }
    let out = serde_json::json!({"ok": true, "token": dst_token, "uid": dst_uid,
        "merged": merged, "profile": {"name": name, "color": color}});
    (StatusCode::OK, axum::Json(out)).into_response()
}
