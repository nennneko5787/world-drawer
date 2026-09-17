//! レベルランキング (公開・認証不要)。
//! `GET /api/ranking?limit=` → `{ok, ranking:[{rank,uid,name,color,level,xp,country}], total}`。
//! 並びは level DESC, xp DESC, uid ASC (決定的)。countryはshowCountry=1のみ。

use crate::routes::AppState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Q {
    pub limit: Option<i64>,
}

pub fn clamp_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(100).clamp(1, 100)
}

pub async fn list(State(state): State<AppState>, Query(q): Query<Q>) -> Response {
    let limit = clamp_limit(q.limit);
    let rows = sqlx::query(
        "SELECT uid, name, color, level, xp,
                CASE WHEN showCountry = 1 THEN country ELSE NULL END,
                COUNT(*) OVER ()
         FROM users ORDER BY level DESC, xp DESC, uid ASC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    use sqlx::Row;
    let mut rank: i64 = 0;
    let mut prev: Option<(i32, i32)> = None;
    let mut total: i64 = 0;
    let ranking: Vec<_> = rows
        .iter()
        .map(|r| {
            let level = r.get::<i32, _>(3);
            let xp = r.get::<i32, _>(4);
            total = r.get::<i64, _>(6);
            // 同率 (level+xp一致) は同順位
            if prev != Some((level, xp)) {
                rank += 1;
                prev = Some((level, xp));
            }
            serde_json::json!({
                "rank": rank,
                "uid": r.get::<String, _>(0),
                "name": r.get::<String, _>(1),
                "color": crate::color::int_to_hex(r.get::<i32, _>(2)),
                "level": level as i64,
                "xp": xp as i64,
                "country": r.get::<Option<String>, _>(5),
            })
        })
        .collect();
    // 空テーブル時は total=0
    let body = serde_json::json!({"ok": true, "ranking": ranking, "total": total});
    (StatusCode::OK, axum::Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_clamped() {
        assert_eq!(clamp_limit(None), 100);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(-5)), 1);
        assert_eq!(clamp_limit(Some(1000)), 100);
        assert_eq!(clamp_limit(Some(10)), 10);
    }
}
