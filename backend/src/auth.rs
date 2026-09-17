//! 認証: `Authorization: Bearer` のみ。
//! body/queryのtokenは受付ない (設計として廃止)。

use axum::http::{HeaderMap, StatusCode};

pub fn bearer(headers: &HeaderMap) -> Result<String, (StatusCode, &'static str)> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    // schemeは大文字小文字を問わない (`Bearer`/`bearer`/`BEARER` 等)。
    // 余分な空白 (`Bearer  <tok>`) も許容する。
    let Some((scheme, cred)) = raw.split_once(char::is_whitespace) else {
        return Err((StatusCode::UNAUTHORIZED, "missingToken"));
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err((StatusCode::UNAUTHORIZED, "missingToken"));
    }
    let tok = cred.trim();
    if tok.is_empty() || tok.len() > 64 {
        return Err((StatusCode::UNAUTHORIZED, "missingToken"));
    }
    Ok(tok.to_string())
}
