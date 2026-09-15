//! 認証: `Authorization: Bearer` のみ。
//! body/queryのtokenは受付ない (設計として廃止)。

use axum::http::{HeaderMap, StatusCode};

pub fn bearer(headers: &HeaderMap) -> Result<String, (StatusCode, &'static str)> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tok = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .unwrap_or("")
        .trim();
    if tok.is_empty() || tok.len() > 64 {
        return Err((StatusCode::UNAUTHORIZED, "missingToken"));
    }
    Ok(tok.to_string())
}
