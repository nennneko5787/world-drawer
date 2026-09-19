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
/// hubは接続 (sid) 単位のため、同一uidの複数接続は1人にまとめる。
/// countは重複排除後の人数 (自分含む)。クライアントは足さずにそのまま表示する。
pub async fn list(State(state): State<AppState>, Query(q): Query<Q>) -> Response {
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let mut seen = std::collections::HashSet::new();
    let mut all = Vec::new();
    for e in state.hub.infos.iter() {
        if !seen.insert(e.value().uid.clone()) {
            continue;
        }
        all.push(
            serde_json::json!({"uid": e.value().uid, "name": e.value().name,
                "color": e.value().color, "level": e.value().level}),
        );
    }
    let count = all.len();
    let online: Vec<serde_json::Value> = all.into_iter().take(limit).collect();
    let body = serde_json::json!({
        "online": online, "count": count, "truncated": count > limit,
    });
    (StatusCode::OK, axum::Json(body)).into_response()
}
