use crate::auth;
use crate::routes::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};

/// WSワンタイムチケット発行 (30秒使い切り)。長期tokenはWSに流さない。
pub async fn create(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Ok(token) = auth::bearer(&headers) else {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            r#"{"ok":false,"error":"missingToken"}"#,
        )
            .into_response();
    };
    // ランダム使い切りチケット (決定的hashはリプレイ可能なので使わない)
    let ticket = format!("t_{}", uuid::Uuid::new_v4().simple());
    state.hub.tickets.insert(
        ticket.clone(),
        (
            token,
            chrono::Utc::now().timestamp() + 30,
        ),
    );
    axum::Json(serde_json::json!({"ok": true, "ticket": ticket})).into_response()
}
