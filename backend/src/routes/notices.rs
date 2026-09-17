//! お知らせ (単一テキスト・管理者投稿・全員閲覧)。
//! GET /api/notices は公開。POST/PUT/DELETE /api/admin/notices* は管理者のみ (UID制)。

use crate::routes::admin::is_admin;
use crate::routes::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ListQ {
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpsertBody {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

fn row_to_notice(
    id: i64,
    title: String,
    body: String,
    created_at: f64,
    updated_at: f64,
) -> serde_json::Value {
    serde_json::json!({
        "id": id, "title": title, "body": body,
        "createdAt": created_at, "updatedAt": updated_at,
    })
}

/// 公開一覧。新しい順。`{ok, notices:[{id,title,body,createdAt,updatedAt}]}`。
pub async fn list(State(state): State<AppState>, Query(q): Query<ListQ>) -> Response {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query(
        "SELECT id, title, body, createdAt, updatedAt FROM notices ORDER BY id DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    use sqlx::Row;
    let notices: Vec<_> = rows
        .iter()
        .map(|r| {
            row_to_notice(
                r.get::<i64, _>(0),
                r.get::<String, _>(1),
                r.get::<String, _>(2),
                r.get::<f64, _>(3),
                r.get::<f64, _>(4),
            )
        })
        .collect();
    let body = serde_json::json!({"ok": true, "notices": notices});
    (StatusCode::OK, axum::Json(body)).into_response()
}

fn clean_title(s: &str) -> String {
    s.trim().chars().take(200).collect::<String>().trim().to_string()
}

fn clean_body(s: &str) -> String {
    s.trim().chars().take(20000).collect::<String>().trim().to_string()
}

/// 管理者投稿。`{title, body}` → `{ok, notice}`。
pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<UpsertBody>,
) -> Response {
    if !is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#).into_response();
    }
    let title = clean_title(&body.title);
    let text = clean_body(&body.body);
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            r#"{"ok":false,"error":"badTitle"}"#,
        )
            .into_response();
    }
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let row = sqlx::query(
        "INSERT INTO notices(title, body, createdAt, updatedAt) VALUES ($1,$2,$3,$3)
         RETURNING id, title, body, createdAt, updatedAt",
    )
    .bind(&title)
    .bind(&text)
    .bind(now)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"ok":false,"error":"busy"}"#,
        )
            .into_response();
    };
    use sqlx::Row;
    let out = row_to_notice(
        r.get::<i64, _>(0),
        r.get::<String, _>(1),
        r.get::<String, _>(2),
        r.get::<f64, _>(3),
        r.get::<f64, _>(4),
    );
    (StatusCode::OK, axum::Json(serde_json::json!({"ok": true, "notice": out}))).into_response()
}

/// 管理者編集。`PUT /api/admin/notices/:id {title, body}`。
pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: axum::Json<UpsertBody>,
) -> Response {
    if !is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#).into_response();
    }
    let title = clean_title(&body.title);
    let text = clean_body(&body.body);
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            r#"{"ok":false,"error":"badTitle"}"#,
        )
            .into_response();
    }
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let row = sqlx::query(
        "UPDATE notices SET title = $1, body = $2, updatedAt = $3 WHERE id = $4
         RETURNING id, title, body, createdAt, updatedAt",
    )
    .bind(&title)
    .bind(&text)
    .bind(now)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (
            StatusCode::OK,
            r#"{"ok":false,"error":"noNotice"}"#,
        )
            .into_response();
    };
    use sqlx::Row;
    let out = row_to_notice(
        r.get::<i64, _>(0),
        r.get::<String, _>(1),
        r.get::<String, _>(2),
        r.get::<f64, _>(3),
        r.get::<f64, _>(4),
    );
    (StatusCode::OK, axum::Json(serde_json::json!({"ok": true, "notice": out}))).into_response()
}

/// 管理者削除。`DELETE /api/admin/notices/:id`。
pub async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    if !is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#).into_response();
    }
    let done = sqlx::query("DELETE FROM notices WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await;
    match done {
        Ok(r) if r.rows_affected() == 1 => (
            StatusCode::OK,
            axum::Json(serde_json::json!({"ok": true, "id": id})),
        )
            .into_response(),
        _ => (StatusCode::OK, r#"{"ok":false,"error":"noNotice"}"#).into_response(),
    }
}
