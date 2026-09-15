use crate::routes::AppState;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Bbox {
    #[serde(alias = "minX")]
    pub min_x: Option<i32>,
    #[serde(alias = "maxX")]
    pub max_x: Option<i32>,
    #[serde(alias = "minY")]
    pub min_y: Option<i32>,
    #[serde(alias = "maxY")]
    pub max_y: Option<i32>,
}

const COORD_LIMIT: i32 = 1_000_000;

/// 視野取得。Edgeキャッシュなし (no-store)。常にDB直読み。
pub async fn bbox(State(state): State<AppState>, Query(q): Query<Bbox>) -> Response {
    let Some((lox, hix, loy, hiy)) = normalize(q) else {
        // bbox無しは全量返さない。metaのみ (フロントの初回取得用)
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pixels")
            .fetch_one(&state.pool)
            .await
            .unwrap_or(0);
        let body = serde_json::json!({
            "pixels": {}, "truncated": false, "pixelCount": count,
            "background": state.cfg.background,
            "cooldown": state.cfg.cooldown_sec,
            "trustedLevel": state.cfg.trusted_level,
            "placeRadius": state.cfg.place_radius,
        });
        return json_no_store(&body);
    };
    let max = state.cfg.max_bbox_pixels;
    let now = chrono::Utc::now().timestamp() as f64;
    // 件数だけ先に数える (index-only)。上限超えは10万行を取らず truncated で返す。
    // ズームアウト時の全走査 (1〜6秒/回) の対策。フロントは truncated でズームインを促す。
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pixels
         WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
         AND (chalkUntil = 0 OR chalkUntil > $5)",
    )
    .bind(lox)
    .bind(hix)
    .bind(loy)
    .bind(hiy)
    .bind(now)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(i64::MAX);
    if count > max as i64 {
        let body = serde_json::json!({
            "pixels": {},
            "truncated": true,
            "bounds": {"minX": lox, "minY": loy, "maxX": hix, "maxY": hiy},
        });
        return json_no_store(&body);
    }
    let rows = sqlx::query(
        "SELECT x, y, c, t, by, coats, chalkUntil, shieldUntil FROM pixels
         WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
         AND (chalkUntil = 0 OR chalkUntil > $5)",
    )
    .bind(lox)
    .bind(hix)
    .bind(loy)
    .bind(hiy)
    .bind(now)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let truncated = false;
    let mut pixels = serde_json::Map::new();
    for r in rows.iter().take(state.cfg.max_bbox_pixels) {
        use sqlx::Row;
        let x: i32 = r.get(0);
        let y: i32 = r.get(1);
        let c: String = crate::color::int_to_hex(r.get::<i32, _>(2));
        let t: String = crate::ws_proto::bits_to_ink(r.get::<i16, _>(3));
        let by: Option<String> = r.get(4);
        let coats: i16 = r.get(5);
        let mut cell = serde_json::json!({"c": c, "t": t, "by": by, "coats": coats});
        let chalk_left: f64 = r.get::<f64, _>(6) - now;
        if chalk_left > 0.0 {
            cell["e"] = serde_json::json!(chalk_left);
            cell["e0"] = serde_json::json!(state.cfg.chalk_minutes * 60.0);
        }
        let shield_left: f64 = r.get::<f64, _>(7) - now;
        if shield_left > 0.0 {
            cell["s"] = serde_json::json!(shield_left);
        }
        pixels.insert(format!("{x},{y}"), cell);
    }
    let body = serde_json::json!({
        "pixels": pixels,
        "truncated": truncated,
        "bounds": {"minX": lox, "minY": loy, "maxX": hix, "maxY": hiy},
    });
    json_no_store(&body)
}

fn normalize(q: Bbox) -> Option<(i32, i32, i32, i32)> {
    let (a, b, c, d) = (q.min_x?, q.max_x?, q.min_y?, q.max_y?);
    let (lox, hix) = (a.min(b).max(-COORD_LIMIT), a.max(b).min(COORD_LIMIT));
    let (loy, hiy) = (c.min(d).max(-COORD_LIMIT), c.max(d).min(COORD_LIMIT));
    Some((lox, hix, loy, hiy))
}

pub async fn bounds(State(state): State<AppState>) -> Response {
    let now = chrono::Utc::now().timestamp() as f64;
    let row: Option<(i64, Option<i32>, Option<i32>, Option<i32>, Option<i32>)> = sqlx::query_as(
        "SELECT COUNT(*), MIN(x), MIN(y), MAX(x), MAX(y) FROM pixels
         WHERE chalkUntil = 0 OR chalkUntil > $1",
    )
    .bind(now)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let body = match row {
        Some((0, _, _, _, _)) | None => serde_json::json!({"count": 0}),
        Some((n, a, b, c, d)) => serde_json::json!({
            "count": n, "minX": a, "minY": b, "maxX": c, "maxY": d,
        }),
    };
    json_no_store(&body)
}

fn json_no_store(v: &serde_json::Value) -> Response {
    Response::builder()
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(axum::body::Body::from(v.to_string()))
        .unwrap()
}

/// OGP画像のみ60sキャッシュ許可。
pub async fn og_image(State(_state): State<AppState>, _h: HeaderMap) -> Response {
    // TODO: picks/ogp_image.rs (原点付近レンダ)
    Response::builder()
        .header("content-type", "image/png")
        .header("cache-control", "public, max-age=60")
        .body(axum::body::Body::from(vec![]))
        .unwrap()
}
