use crate::routes::AppState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Q {
    pub limit: Option<usize>,
}

/// オンライン一覧 (WS不可時のフォールバック専用)。上限打切り+count。
pub async fn list(State(state): State<AppState>, Query(q): Query<Q>) -> Response {
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let online: Vec<serde_json::Value> = state
        .hub
        .peers
        .iter()
        .take(limit)
        .map(|e| serde_json::json!({"uid": e.key()}))
        .collect();
    let count = state.hub.peers.len();
    let body = serde_json::json!({
        "online": online, "count": count, "truncated": count > limit,
    });
    (StatusCode::OK, axum::Json(body)).into_response()
}
