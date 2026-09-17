use crate::auth;
use crate::routes::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use redis::AsyncCommands;
use serde::Deserialize;

pub(crate) async fn is_admin(state: &AppState, headers: &HeaderMap) -> bool {
    let Ok(tok) = auth::bearer(headers) else {
        return false;
    };
    let row = sqlx::query("SELECT uid FROM users WHERE token = $1")
        .bind(&tok)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    let Some(r) = row else {
        return false;
    };
    use sqlx::Row;
    let uid: String = r.get(0);
    state.cfg.is_admin_uid(&uid)
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

pub async fn status(State(mut state): State<AppState>, headers: HeaderMap) -> Response {
    if !is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#)
            .into_response();
    }
    let presence = state.hub.live_count();
    let banned = ban_list(&mut state).await;
    let body = serde_json::json!({"ok": true, "presence": presence, "sockets": presence,
        "banned": banned,
        "config": {"placePerMinPerIp": state.cfg.place_per_min_per_ip,
                   "sessionPerHour": 30,
                   "requireSocketForPlace": state.cfg.require_socket_for_place,
                   "maxSocketsPerIp": state.cfg.max_sockets_per_ip}});
    (StatusCode::OK, axum::Json(body)).into_response()
}

/// 有効ban一覧。期限切れ・壊値は掃除する (Python banList相当)
async fn ban_list(state: &mut AppState) -> Vec<serde_json::Value> {
    use redis::AsyncCommands;
    let map: std::collections::HashMap<String, String> =
        state.redis.hgetall("wd:bans").await.unwrap_or_default();
    let now = chrono::Utc::now().timestamp() as f64;
    let mut out = vec![];
    let mut dead = vec![];
    for (ip, raw) in map {
        match raw.trim().parse::<f64>() {
            Ok(until) if until > now => {
                out.push(serde_json::json!({"ip": ip, "until": until}))
            }
            _ => dead.push(ip),
        }
    }
    if !dead.is_empty() {
        let _: Result<(), _> = state.redis.hdel("wd:bans", &dead).await;
    }
    out
}

pub async fn lookup(
    State(mut state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<LookupBody>,
) -> Response {
    if !is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#)
            .into_response();
    }
    let uid = body.uid.trim().chars().take(16).collect::<String>();
    let row = sqlx::query(
        "SELECT token, uid, name, color, level, xp, inventory, country, showCountry
         FROM users WHERE uid = $1",
    )
    .bind(&uid)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (StatusCode::OK, r#"{"ok":false,"error":"noUser"}"#).into_response();
    };
    use sqlx::Row;
    let token: String = r.get(0);
    let keys = ["glow", "rainbow", "ghost", "chalk", "shield"]
        .iter()
        .map(|k| k.to_string())
        .collect::<Vec<_>>();
    let touched: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pixels WHERE by = $1")
        .bind(&uid)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);
    let last_ip = crate::rate::last_ip(&mut state.redis, &token).await;
    let online = state.hub.infos.iter().any(|e| e.value().uid == uid);
    let out = serde_json::json!({"ok": true, "user": {
        "uid": r.get::<String, _>(1), "name": r.get::<String, _>(2),
        "color": crate::color::int_to_hex(r.get::<i32, _>(3)),
        "level": r.get::<i32, _>(4) as i64, "xp": r.get::<i32, _>(5) as i64,
        "inventory": crate::users::parse_inventory(&r.get::<String, _>(6), &keys),
        "country": r.get::<Option<String>, _>(7), "showCountry": r.get::<i32, _>(8) != 0,
        "touchedCells": touched, "lastIp": last_ip, "online": online,
    }});
    (StatusCode::OK, axum::Json(out)).into_response()
}

pub async fn rollback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<RollbackBody>,
) -> Response {
    if !is_admin(&state, &headers).await {
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
        "SELECT DISTINCT x, y FROM history WHERE uid = $1 AND NOT undone LIMIT $2",
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
             WHERE x = $1 AND y = $2 AND NOT undone ORDER BY id DESC LIMIT 2",
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
        let _ = sqlx::query("UPDATE history SET undone = true WHERE id = $1")
            .bind(rid)
            .execute(&mut *tx)
            .await;
        if rows.len() < 2 {
            let _ = sqlx::query("DELETE FROM pixels WHERE x = $1 AND y = $2")
                .bind(x)
                .bind(y)
                .execute(&mut *tx)
                .await;
            events.push(serde_json::json!({"x": x, "y": y, "erased": true,
                "c": "#ffffff", "t": "normal", "coats": 1}));
        } else {
            let pc: i32 = rows[1].get(2);
            let pt: i16 = rows[1].get(3);
            let pu: String = rows[1].get(1);
            let _ = sqlx::query(
                "INSERT INTO pixels(x, y, c, t, by, coats, shieldUntil) VALUES ($1,$2,$3,$4,$5,1,0)
                 ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t, by=excluded.by,
                 coats=1, shieldUntil=0, chalkUntil=0",
            )
            .bind(x)
            .bind(y)
            .bind(pc)
            .bind(pt)
            .bind(&pu)
            .execute(&mut *tx)
            .await;
            let pt_s = crate::ws_proto::bits_to_ink(pt);
            events.push(serde_json::json!({"x": x, "y": y,
                "c": crate::color::int_to_hex(pc), "t": pt_s, "by": pu, "coats": 1}));
        }
        restored += 1;
        xp_taken += rxp;
    }
    let mut level: i64 = (tg.get::<i32, _>(0) as i64).max(1);
    let mut xp = tg.get::<i32, _>(1) as i64 - xp_taken;
    while xp < 0 && level > 1 {
        level -= 1;
        xp += crate::users::xp_needed_for_level(level, state.cfg.xp_base, state.cfg.xp_pow);
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
        let msg = ws_proto::pixel_bin(x, y, r, g, b, ink, 1, by);
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
    if !is_admin(&state, &headers).await {
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
