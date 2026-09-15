use crate::routes::AppState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Q {
    pub x: i32,
    pub y: i32,
    pub limit: Option<i64>,
    pub before_id: Option<i64>,
}

pub async fn history(State(state): State<AppState>, Query(q): Query<Q>) -> Response {
    if q.x.abs() > 1_000_000 || q.y.abs() > 1_000_000 {
        return (StatusCode::BAD_REQUEST, r#"{"ok":false,"error":"outOfBounds"}"#)
            .into_response();
    }
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    let rows = if let Some(b) = q.before_id {
        sqlx::query(
            "SELECT h.id, h.uid, COALESCE(u.name,'ななし'), COALESCE(u.color,'#22aa66'),
                    h.c, h.t, h.at,
                    CASE WHEN u.showCountry = 1 THEN u.country ELSE NULL END,
                    COALESCE(u.level,1)
             FROM history h LEFT JOIN users u ON u.uid = h.uid
             WHERE h.x = $1 AND h.y = $2 AND h.undone = 0 AND h.id < $3
             ORDER BY h.id DESC LIMIT $4",
        )
        .bind(q.x)
        .bind(q.y)
        .bind(b)
        .bind(limit + 1)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query(
            "SELECT h.id, h.uid, COALESCE(u.name,'ななし'), COALESCE(u.color,'#22aa66'),
                    h.c, h.t, h.at,
                    CASE WHEN u.showCountry = 1 THEN u.country ELSE NULL END,
                    COALESCE(u.level,1)
             FROM history h LEFT JOIN users u ON u.uid = h.uid
             WHERE h.x = $1 AND h.y = $2 AND h.undone = 0
             ORDER BY h.id DESC LIMIT $3",
        )
        .bind(q.x)
        .bind(q.y)
        .bind(limit + 1)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    };
    use sqlx::Row;
    let has_more = rows.len() as i64 > limit;
    let items: Vec<_> = rows
        .iter()
        .take(limit as usize)
        .map(|r| {
            serde_json::json!({
                "id": r.get::<i64, _>(0), "uid": r.get::<String, _>(1),
                "name": r.get::<String, _>(2), "userColor": r.get::<String, _>(3),
                "c": r.get::<String, _>(4), "t": r.get::<String, _>(5),
                "at": r.get::<f64, _>(6), "country": r.get::<Option<String>, _>(7),
                "level": r.get::<i32, _>(8) as i64,
            })
        })
        .collect();
    let body = serde_json::json!({"ok": true, "x": q.x, "y": q.y, "items": items, "hasMore": has_more});
    (StatusCode::OK, axum::Json(body)).into_response()
}
