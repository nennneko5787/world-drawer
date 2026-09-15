use crate::auth;
use crate::routes::AppState;
use crate::users;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Body {
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub show_country: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<Body>,
) -> Response {
    let Ok(token) = auth::bearer(&headers) else {
        return (StatusCode::UNAUTHORIZED, r#"{"ok":false,"error":"missingToken"}"#)
            .into_response();
    };
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
    let row = sqlx::query(
        "SELECT name, color, showCountry, country FROM users WHERE token = $1 FOR UPDATE",
    )
    .bind(&token)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (StatusCode::NOT_FOUND, r#"{"ok":false,"error":"noUser"}"#).into_response();
    };
    use sqlx::Row;
    let cur_color: String = r.get(1);
    let cur_show: i32 = r.get(2);
    let cur_country: Option<String> = r.get(3);
    let new_name = users::clean_name(&body.name, 20, "ななし");
    let new_color = users::clean_color(&body.color, &cur_color);
    let new_show = body.show_country.unwrap_or(cur_show != 0);
    let _ = sqlx::query(
        "UPDATE users SET name = $1, color = $2, showCountry = $3 WHERE token = $4",
    )
    .bind(&new_name)
    .bind(&new_color)
    .bind(if new_show { 1 } else { 0 })
    .bind(&token)
    .execute(&mut *tx)
    .await;
    if tx.commit().await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"ok":false,"error":"busy"}"#,
        )
            .into_response();
    }
    let out = serde_json::json!({"ok": true, "profile": {
        "name": new_name, "color": new_color,
        "country": cur_country, "showCountry": new_show,
    }});
    (StatusCode::OK, axum::Json(out)).into_response()
}
