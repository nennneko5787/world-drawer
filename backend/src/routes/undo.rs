use crate::auth;
use crate::place_logic;
use crate::routes::AppState;
use crate::users;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

/// 取消リクエスト。prev検証はPython normalizeUndoPrev互換。
#[derive(Deserialize)]
pub struct UndoBody {
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub prev_empty: bool,
    #[serde(default = "def_black")]
    pub prev_c: String,
    #[serde(default = "def_normal")]
    pub prev_t: String,
    #[serde(default = "def_coats")]
    pub prev_coats: i32,
}
fn def_black() -> String {
    "#000000".into()
}
fn def_normal() -> String {
    "normal".into()
}
fn def_coats() -> i32 {
    1
}

pub async fn undo(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<UndoBody>,
) -> Response {
    let Ok(token) = auth::bearer(&headers) else {
        return err(StatusCode::UNAUTHORIZED, "missingToken");
    };
    if !place_logic::in_bounds(body.x, body.y, 1_000_000) {
        return err(StatusCode::BAD_REQUEST, "outOfBounds");
    }
    // prev検証
    if !body.prev_empty {
        if !place_logic::is_hex_color(&body.prev_c) {
            return err(StatusCode::BAD_REQUEST, "badPrev");
        }
        let allowed = ["normal", "glow", "rainbow", "ghost", "chalk", "shield"];
        let parts: Vec<&str> = body.prev_t.split('+').collect();
        if parts.is_empty() || parts.iter().any(|p| !allowed.contains(p)) {
            return err(StatusCode::BAD_REQUEST, "badPrev");
        }
        if parts.contains(&"normal") && parts.len() > 1 {
            return err(StatusCode::BAD_REQUEST, "badPrev");
        }
    }

    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return err(StatusCode::SERVICE_UNAVAILABLE, "busy"),
    };
    let now = chrono::Utc::now().timestamp() as f64;
    // 本人行ロック
    let user = sqlx::query(
        "SELECT token, uid, name, color, inventory, cooldownUntil, level, xp,
                transferCode, passwordHash, country, showCountry
         FROM users WHERE token = $1 FOR UPDATE",
    )
    .bind(&token)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    let Some(u) = user else {
        return err(StatusCode::NOT_FOUND, "noUndo");
    };
    use sqlx::Row;
    let uid: String = u.get(1);
    // 最新履歴
    let last = sqlx::query(
        "SELECT id, uid, c, t, at, undone, xp FROM history
         WHERE x = $1 AND y = $2 ORDER BY id DESC LIMIT 1",
    )
    .bind(body.x)
    .bind(body.y)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    let Some(h) = last else {
        return err(StatusCode::CONFLICT, "noUndo");
    };
    let hid: i64 = h.get(0);
    let huid: String = h.get(1);
    let hc: String = h.get(2);
    let ht: String = h.get(3);
    let hat: f64 = h.get(4);
    let hundone: i32 = h.get(5);
    if huid != uid || hundone != 0 || now - hat > 3.0 {
        return err(StatusCode::CONFLICT, "tooLate");
    }
    // 現在値一致
    let cur = sqlx::query("SELECT c, t FROM pixels WHERE x = $1 AND y = $2")
        .bind(body.x)
        .bind(body.y)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None);
    if ht == "erase" {
        if cur.is_some() {
            return err(StatusCode::CONFLICT, "changed");
        }
    } else if let Some(c) = cur {
        use sqlx::Row;
        let cc: String = c.get(0);
        let tt: String = c.get(1);
        if cc != hc || tt != ht {
            return err(StatusCode::CONFLICT, "changed");
        }
    } else {
        return err(StatusCode::CONFLICT, "changed");
    }
    // 復元
    if body.prev_empty {
        let _ = sqlx::query("DELETE FROM pixels WHERE x = $1 AND y = $2")
            .bind(body.x)
            .bind(body.y)
            .execute(&mut *tx)
            .await;
    } else {
        let _ = sqlx::query(
            "INSERT INTO pixels(x, y, c, t, by, coats) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t, coats=excluded.coats",
        )
        .bind(body.x)
        .bind(body.y)
        .bind(body.prev_c.to_lowercase())
        .bind(&body.prev_t)
        .bind(&uid)
        .bind(body.prev_coats.clamp(0, 5))
        .execute(&mut *tx)
        .await;
        let _ = sqlx::query(
            "UPDATE pixels SET shieldUntil = 0, chalkUntil = 0 WHERE x = $1 AND y = $2",
        )
        .bind(body.x)
        .bind(body.y)
        .execute(&mut *tx)
        .await;
    }
    let _ = sqlx::query("UPDATE history SET undone = 1 WHERE id = $1")
        .bind(hid)
        .execute(&mut *tx)
        .await;
    // 経験値巻戻し (簡易: xp付与分1を引く)
    let xp_grant: i64 = h.get::<i32, _>(6) as i64;
    let mut level = users::clamp_level(u.get::<i32, _>(6) as i64);
    let mut xp = u.get::<i32, _>(7) as i64 - xp_grant;
    while xp < 0 && level > 1 {
        level -= 1;
        xp += users::xp_needed_for_level(level, state.cfg.xp_base, state.cfg.xp_pow);
    }
    xp = xp.max(0);
    let inv_raw: String = u.get(4);
    let keys = ["glow", "rainbow", "ghost", "chalk", "shield"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let mut inv = users::parse_inventory(&inv_raw, &keys);
    for p in ht.split('+') {
        if keys.iter().any(|k| k == p) {
            *inv.entry(p.to_string()).or_insert(0) += 1;
        }
    }
    let inv_json = serde_json::to_string(&inv).unwrap_or_default();
    let _ = sqlx::query("UPDATE users SET inventory = $1, level = $2, xp = $3 WHERE token = $4")
        .bind(&inv_json)
        .bind(level)
        .bind(xp)
        .bind(&token)
        .execute(&mut *tx)
        .await;
    if tx.commit().await.is_err() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "busy");
    }
    state.tiles.bump(body.x, body.y);
    let _ = state.hub.pixel_tx.send(
        serde_json::json!({"kind": "pixel", "x": body.x, "y": body.y, "c": body.prev_c, "t": body.prev_t, "by": uid}).to_string(),
    );
    let out = serde_json::json!({"ok": true, "x": body.x, "y": body.y,
        "level": level, "xp": xp,
        "xpNeeded": users::xp_needed_for_level(level, state.cfg.xp_base, state.cfg.xp_pow),
        "inventory": inv});
    (StatusCode::OK, axum::Json(out)).into_response()
}

fn err(status: StatusCode, code: &str) -> Response {
    let body = serde_json::json!({"ok": false, "error": code});
    (status, axum::Json(body)).into_response()
}
