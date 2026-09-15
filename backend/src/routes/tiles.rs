use crate::routes::AppState;
use crate::tiles::{self, MAX_TILES_PER_REQ, TILE};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
pub struct Q {
    /// "tx,ty;tx,ty..." (可視タイル)
    pub need: Option<String>,
    /// "tx,ty:v;..." (手持ちの版)
    pub known: Option<String>,
}

fn parse_tiles(s: &str, limit: usize) -> Vec<(i32, i32)> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    for part in s.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let mut it = part.split(',');
        let (Some(a), Some(b)) = (it.next(), it.next()) else {
            continue;
        };
        if it.next().is_some() {
            continue;
        }
        let (Ok(tx), Ok(ty)) = (a.parse::<i32>(), b.parse::<i32>()) else {
            continue;
        };
        if tx.abs() > 20000 || ty.abs() > 20000 {
            continue;
        }
        if seen.insert((tx, ty)) {
            out.push((tx, ty));
        }
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn parse_known(s: &str) -> HashMap<(i32, i32), u64> {
    let mut out = HashMap::new();
    for part in s.split(';') {
        // "tx,ty:v" 形式
        let mut kv = part.split(':');
        let (Some(k), Some(v)) = (kv.next(), kv.next()) else {
            continue;
        };
        if kv.next().is_some() {
            continue;
        }
        let mut xy = k.split(',');
        let (Some(a), Some(b)) = (xy.next(), xy.next()) else {
            continue;
        };
        if xy.next().is_some() {
            continue;
        }
        if let (Ok(tx), Ok(ty), Ok(ver)) =
            (a.parse::<i32>(), b.parse::<i32>(), v.parse::<u64>())
        {
            out.insert((tx, ty), ver);
        }
    }
    out
}

/// タイル差分取得。変わったタイルだけpixels付きで返す。
/// no-store (版で差分判定するためキャッシュ不要)。
pub async fn tiles(State(state): State<AppState>, Query(q): Query<Q>) -> Response {
    let need_src = q.need.as_deref().unwrap_or("");
    let need = parse_tiles(need_src, MAX_TILES_PER_REQ + 1);
    if need.len() > MAX_TILES_PER_REQ {
        let body = serde_json::json!({"tiles": {}, "truncated": true});
        return (StatusCode::OK, axum::Json(body)).into_response();
    }
    if need.is_empty() {
        let body = serde_json::json!({"tiles": {}, "truncated": false});
        return (StatusCode::OK, axum::Json(body)).into_response();
    }
    let known = parse_known(q.known.as_deref().unwrap_or(""));
    // 版突合せを先にやる。全部最新ならDBに触らない (パン毎の全量取得の根絶)。
    // 従来は変わりが無くても外接矩形の全行を取って捨てていた
    let mut fresh: HashMap<(i32, i32), u64> = HashMap::new();
    let mut stale: Vec<(i32, i32)> = vec![];
    for (tx, ty) in &need {
        let v = state.tiles.get(*tx, *ty);
        fresh.insert((*tx, *ty), v);
        if known.get(&(*tx, *ty)) != Some(&v) {
            stale.push((*tx, *ty));
        }
    }
    let mut out = serde_json::Map::new();
    if stale.is_empty() {
        for (k, v) in &fresh {
            out.insert(format!("{},{}", k.0, k.1), serde_json::json!({"v": v}));
        }
        let body = serde_json::json!({"tiles": out, "truncated": false});
        return (StatusCode::OK, axum::Json(body)).into_response();
    }
    // 陳腐タイルだけの外接矩形を1クエリで取得して振り分ける。
    // 行数上限付き (散らばった濃密タイルの大量要求でメモリを食い潰さないため)
    const ROW_CAP: i64 = 100001;
    let (mut lox, mut hix, mut loy, mut hiy) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
    for (tx, ty) in &stale {
        lox = lox.min(tx * TILE);
        hix = hix.max(tx * TILE + TILE - 1);
        loy = loy.min(ty * TILE);
        hiy = hiy.max(ty * TILE + TILE - 1);
    }
    let now = chrono::Utc::now().timestamp() as f64;
    let rows = sqlx::query(
        "SELECT x, y, c, ci, t, by, coats FROM pixels
         WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
         AND (chalkUntil = 0 OR chalkUntil > $5) LIMIT $6",
    )
    .bind(lox)
    .bind(hix)
    .bind(loy)
    .bind(hiy)
    .bind(now)
    .bind(ROW_CAP)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    if rows.len() as i64 >= ROW_CAP {
        //  capped → ズームインを促す (旧bboxと同じ契約)
        let body = serde_json::json!({"tiles": {}, "truncated": true});
        return (StatusCode::OK, axum::Json(body)).into_response();
    }

    let mut bucket: HashMap<(i32, i32), serde_json::Map<String, serde_json::Value>> =
        HashMap::new();
    for r in &rows {
        use sqlx::Row;
        let x: i32 = r.get(0);
        let y: i32 = r.get(1);
        let k = tiles::tile_of(x, y);
        // ci優先・cフォールバック。APIはhexのまま (フロント無変更)
        let c: String = crate::color::resolve_hex(&r.get::<String, _>(2), r.get::<Option<i32>, _>(3));
        let cell = serde_json::json!({
            "c": c, "t": r.get::<String, _>(4),
            "by": r.get::<Option<String>, _>(5), "coats": r.get::<i32, _>(6),
        });
        bucket.entry(k).or_default().insert(format!("{x},{y}"), cell);
    }
    let mut out = serde_json::Map::new();
    for (tx, ty) in &need {
        let v = fresh[&(*tx, *ty)];
        if known.get(&(*tx, *ty)) == Some(&v) {
            out.insert(format!("{tx},{ty}"), serde_json::json!({"v": v}));
        } else {
            let pixels = bucket.remove(&(*tx, *ty)).unwrap_or_default();
            out.insert(format!("{tx},{ty}"), serde_json::json!({"v": v, "pixels": pixels}));
        }
    }
    let body = serde_json::json!({"tiles": out, "truncated": false});
    (StatusCode::OK, axum::Json(body)).into_response()
}
