use crate::auth;
use crate::routes::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use redis::AsyncCommands;
use serde::Deserialize;

fn is_admin(state: &AppState, headers: &HeaderMap) -> bool {
    let Ok(tok) = auth::bearer(headers) else {
        return false;
    };
    // 定数時間比較寄り (件数が少ないため単純比較+長さ一致)
    state.cfg.admin_tokens.iter().any(|a| {
        a.len() == tok.len() && a.bytes().zip(tok.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
    })
}

#[derive(Deserialize)]
pub struct LookupBody {
    pub uid: String,
}

#[derive(Deserialize)]
pub struct RollbackBody {
    pub uid: String,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct BanBody {
    pub ip: String,
    pub seconds: Option<f64>,
}

pub async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !is_admin(&state, &headers) {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#)
            .into_response();
    }
    let presence = state.hub.live_count();
    let body = serde_json::json!({"ok": true, "presence": presence,
        "config": {"maxSocketsPerIp": 64}});
    (StatusCode::OK, axum::Json(body)).into_response()
}

pub async fn lookup(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<LookupBody>,
) -> Response {
    if !is_admin(&state, &headers) {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#)
            .into_response();
    }
    let uid = body.uid.trim().chars().take(16).collect::<String>();
    let row = sqlx::query(
        "SELECT uid, name, color, level, xp FROM users WHERE uid = $1",
    )
    .bind(&uid)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (StatusCode::OK, r#"{"ok":false,"error":"noUser"}"#).into_response();
    };
    use sqlx::Row;
    let out = serde_json::json!({"ok": true, "user": {
        "uid": r.get::<String, _>(0), "name": r.get::<String, _>(1),
        "color": r.get::<String, _>(2), "level": r.get::<i32, _>(3) as i64,
        "xp": r.get::<i32, _>(4) as i64,
    }});
    (StatusCode::OK, axum::Json(out)).into_response()
}

pub async fn rollback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<RollbackBody>,
) -> Response {
    if !is_admin(&state, &headers) {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#)
            .into_response();
    }
    let uid = body.uid.trim().chars().take(16).collect::<String>();
    let limit = body.limit.unwrap_or(1000).clamp(1, 5000);
    if uid.is_empty() {
        return (StatusCode::BAD_REQUEST, r#"{"ok":false,"error":"badUid"}"#).into_response();
    }
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
    let target = sqlx::query("SELECT level, xp, inventory FROM users WHERE uid = $1 FOR UPDATE")
        .bind(&uid)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None);
    let Some(tg) = target else {
        return (StatusCode::OK, r#"{"ok":false,"error":"noUser"}"#).into_response();
    };
    use sqlx::Row;
    let cells: Vec<(i32, i32)> = sqlx::query(
        "SELECT DISTINCT x, y FROM history WHERE uid = $1 AND undone = 0 LIMIT $2",
    )
    .bind(&uid)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await
    .unwrap_or_default()
    .iter()
    .map(|r| (r.get(0), r.get(1)))
    .collect();
    let truncated = cells.len() as i64 > limit;
    let mut restored = 0;
    let mut skipped = 0;
    let mut xp_taken: i64 = 0;
    let mut events = vec![];
    for (x, y) in cells.iter().take(limit as usize) {
        let rows = sqlx::query(
            "SELECT id, uid, c, t, xp FROM history
             WHERE x = $1 AND y = $2 AND undone = 0 ORDER BY id DESC LIMIT 2",
        )
        .bind(x)
        .bind(y)
        .fetch_all(&mut *tx)
        .await
        .unwrap_or_default();
        if rows.is_empty() || rows[0].get::<String, _>(1) != uid {
            skipped += 1;
            continue;
        }
        let rid: i64 = rows[0].get(0);
        let rxp: i64 = rows[0].get::<i32, _>(4) as i64;
        let _ = sqlx::query("UPDATE history SET undone = 1 WHERE id = $1")
            .bind(rid)
            .execute(&mut *tx)
            .await;
        if rows.len() < 2 {
            let _ = sqlx::query("DELETE FROM pixels WHERE x = $1 AND y = $2")
                .bind(x)
                .bind(y)
                .execute(&mut *tx)
                .await;
            events.push(serde_json::json!({"kind": "pixel", "x": x, "y": y, "c": "#ffffff", "t": "normal", "erased": true}));
        } else {
            let pc: i32 = rows[1].get(2);
            let pt: String = rows[1].get(3);
            let pu: String = rows[1].get(1);
            let _ = sqlx::query(
                "INSERT INTO pixels(x, y, c, t, by, coats, shieldUntil) VALUES ($1,$2,$3,$4,$5,1,0)
                 ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t, by=excluded.by,
                 coats=1, shieldUntil=0, chalkUntil=0",
            )
            .bind(x)
            .bind(y)
            .bind(pc)
            .bind(&pt)
            .bind(&pu)
            .execute(&mut *tx)
            .await;
            events.push(serde_json::json!({"kind": "pixel", "x": x, "y": y, "c": crate::color::int_to_hex(pc), "t": pt, "by": pu}));
        }
        restored += 1;
        xp_taken += rxp;
    }
    let mut level: i64 = (tg.get::<i32, _>(0) as i64).max(1);
    let mut xp = tg.get::<i32, _>(1) as i64 - xp_taken;
    while xp < 0 && level > 1 {
        level -= 1;
        xp += crate::users::xp_needed_for_level(level, 3.0, 1.5);
    }
    xp = xp.max(0);
    let _ = sqlx::query("UPDATE users SET level = $1, xp = $2 WHERE uid = $3")
        .bind(level)
        .bind(xp)
        .bind(&uid)
        .execute(&mut *tx)
        .await;
    if tx.commit().await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"ok":false,"error":"busy"}"#,
        )
            .into_response();
    }
    for (x, y) in cells.iter().take(limit as usize) {
        state.tiles.bump(*x, *y);
    }
    for ev in &events {
        use crate::tiles::tile_of;
        use crate::ws::WsOut;
        use crate::ws_proto::{self, ink_to_bits};
        let x = ev.get("x").and_then(|n| n.as_i64()).unwrap_or(0) as i32;
        let y = ev.get("y").and_then(|n| n.as_i64()).unwrap_or(0) as i32;
        let c = ev.get("c").and_then(|s| s.as_str()).unwrap_or("#ffffff");
        let t = ev.get("t").and_then(|s| s.as_str()).unwrap_or("normal");
        let by = ev.get("by").and_then(|s| s.as_str()).unwrap_or("");
        let (r, g, b) = crate::color::hex_to_rgb(c);
        let ink = if ev.get("erased").and_then(|e| e.as_bool()).unwrap_or(false) {
            ink_to_bits("erase")
        } else {
            ink_to_bits(t)
        };
        let msg = WsOut::Bin(ws_proto::pixel_bin(x, y, r, g, b, ink, 1, by));
        state.hub.send_to_watchers(tile_of(x, y), &msg, None);
    }
    let out = serde_json::json!({"ok": true, "uid": uid, "restored": restored,
        "skipped": skipped, "truncated": truncated, "level": level, "xp": xp, "events": events});
    (StatusCode::OK, axum::Json(out)).into_response()
}

pub async fn ban(
    State(mut state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<BanBody>,
) -> Response {
    if !is_admin(&state, &headers) {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#)
            .into_response();
    }
    let ip = body.ip.trim().to_string();
    if ip.parse::<std::net::IpAddr>().is_err() {
        return (StatusCode::BAD_REQUEST, r#"{"ok":false,"error":"badIp"}"#).into_response();
    }
    let secs = body.seconds.unwrap_or(86400.0);
    if secs <= 0.0 {
        let _: Result<(), _> = state.redis.hdel("wd:bans", &ip).await;
        let out = serde_json::json!({"ok": true, "ip": ip, "banned": false});
        return (StatusCode::OK, axum::Json(out)).into_response();
    }
    let until = chrono::Utc::now().timestamp() as f64 + secs.max(1.0);
    let r: Result<(), _> = state.redis.hset("wd:bans", &ip, until).await;
    if r.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"ok":false,"error":"busy"}"#,
        )
            .into_response();
    }
    let out = serde_json::json!({"ok": true, "ip": ip, "banned": true, "until": until});
    (StatusCode::OK, axum::Json(out)).into_response()
}
