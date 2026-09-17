use crate::auth;
use crate::ip;
use crate::place_logic::{self, MAX_GHOST_COATS};
use crate::rate;
use crate::routes::AppState;
use crate::users;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rand::Rng;
use serde::Deserialize;
use std::net::SocketAddr;
use std::time::Duration;

#[derive(Deserialize)]
pub struct PlaceBody {
    pub x: i32,
    pub y: i32,
    pub color: Option<String>,
    pub ink: Option<String>,
}

/// 配置。Bearerのみ。body内tokenは無視する。
pub async fn place(
    State(mut state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: axum::Json<PlaceBody>,
) -> Response {
    let Ok(token) = auth::bearer(&headers) else {
        return err(StatusCode::UNAUTHORIZED, "missingToken");
    };
    if !place_logic::in_bounds(body.x, body.y, 1_000_000) {
        return err(StatusCode::BAD_REQUEST, "outOfBounds");
    }
    let ink = body.ink.clone().unwrap_or_else(|| "normal".into());
    if ink != "normal" && ink != "erase" && place_logic::parse_combo_ink(&ink).is_none() {
        return err(StatusCode::BAD_REQUEST, "unknownInk");
    }
    if ink != "erase" && ink != "normal" && !place_logic::is_hex_color(
        body.color.as_deref().unwrap_or(""),
    ) {
        // rainbow単体は色不要だが、他は要HEX (Python resolveComboColor互換の簡易版)
        if !ink.split('+').all(|p| p == "rainbow") {
            return err(StatusCode::BAD_REQUEST, "badColor");
        }
    }
    if ink == "normal"
        && !place_logic::is_hex_color(body.color.as_deref().unwrap_or(""))
    {
        return err(StatusCode::BAD_REQUEST, "badColor");
    }

    // IP解決 (trustedProxies経由のみヘッダ信用)
    let nets = ip::parse_nets(&state.cfg.trusted_proxies);
    let client_ip = ip::client_ip_from_headers(&headers, &peer, &nets);

    // ban執行 (管理banを配置で効かせる。Redis障害時は通す)
    if rate::ban_remaining(&mut state.redis, &client_ip).await > 0.0 {
        return err(StatusCode::FORBIDDEN, "banned");
    }

    // IP共有バケツ (成功分のみ計数すべきだが、簡易版は試行時計数。詳細はTODO)
    let place_limit = state.cfg.place_per_min_per_ip.max(1);
    if client_ip != "unknown"
        && !rate::allow(&mut state.redis, "place", &client_ip, place_limit, 60.0).await
    {
        return err(StatusCode::TOO_MANY_REQUESTS, "ipBusy");
    }

    // socket必須 + カーソル照合 (REST直叩きの自動配置を封じる)
    if state.cfg.require_socket_for_place {
        if !state.hub.token_has_live(&token) {
            return err(StatusCode::FORBIDDEN, "noSocket");
        }
        if !state.hub.cursor_matches(&token, body.x, body.y) {
            tokio::time::sleep(Duration::from_millis(
                place_logic::CURSOR_WAIT_MS,
            ))
            .await;
            if !state.hub.cursor_matches(&token, body.x, body.y) {
                return err(StatusCode::CONFLICT, "cursorMismatch");
            }
        }
    }

    // トランザクション + 行ロック
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return err(StatusCode::SERVICE_UNAVAILABLE, "busy"),
    };
    let now = chrono::Utc::now().timestamp() as f64;
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
        return err(StatusCode::NOT_FOUND, "noUser");
    };
    use sqlx::Row;
    let uid: String = u.get(1);
    // 最終IP記録 (荒らし特定用)
    crate::rate::note_last_ip(&mut state.redis, &token, &client_ip).await;
    let level = users::clamp_level(u.get::<i32, _>(6) as i64);
    let cd_until: f64 = u.get(5);
    if cd_until > now {
        let remain = (cd_until - now).max(0.0);
        let body = serde_json::json!({
            "ok": false, "error": "cooldown",
            "remaining": (remain * 100.0).round() / 100.0,
            "cooldownUntil": cd_until,
        });
        return (StatusCode::TOO_MANY_REQUESTS, axum::Json(body)).into_response();
    }

    // 期限切れチョークの遅延消去
    let chalk: Option<f64> = sqlx::query_scalar(
        "SELECT chalkUntil FROM pixels WHERE x = $1 AND y = $2",
    )
    .bind(body.x)
    .bind(body.y)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None)
    .flatten();
    if let Some(until) = chalk {
        if until > 0.0 && until <= now {
            let _ = sqlx::query("DELETE FROM pixels WHERE x = $1 AND y = $2")
                .bind(body.x)
                .bind(body.y)
                .execute(&mut *tx)
                .await;
        }
    }
    // シールド (他人・有効期限内は拒否)
    if let Some(row) = sqlx::query("SELECT by, shieldUntil FROM pixels WHERE x = $1 AND y = $2")
        .bind(body.x)
        .bind(body.y)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None)
    {
        use sqlx::Row;
        let by: Option<String> = row.get(0);
        let until: f64 = row.get(1);
        if until > now && by.as_deref() != Some(uid.as_str()) {
            let body = serde_json::json!({
                "ok": false, "error": "shielded",
                "remaining": (until - now) as i64,
            });
            return (StatusCode::CONFLICT, axum::Json(body)).into_response();
        }
    }

    // 半径制限 (低レベルは既存ピクセル近傍のみ。全件COUNTは使わない。
    // 空キャンバスの初手は許可。presence近傍は廃止=仕様)
    if level < state.cfg.trusted_level {
        let any: Option<i32> = sqlx::query_scalar("SELECT 1 FROM pixels LIMIT 1")
            .fetch_optional(&mut *tx)
            .await
            .unwrap_or(None);
        if any.is_some() {
            let r = state.cfg.place_radius;
            let near: Option<i32> = sqlx::query_scalar(
                "SELECT 1 FROM pixels
                  WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4 LIMIT 1",
            )
            .bind(body.x.saturating_sub(r))
            .bind(body.x.saturating_add(r))
            .bind(body.y.saturating_sub(r))
            .bind(body.y.saturating_add(r))
            .fetch_optional(&mut *tx)
            .await
            .unwrap_or(None);
            if near.is_none() {
                let body = serde_json::json!({
                    "ok": false, "error": "tooFar", "radius": state.cfg.place_radius,
                });
                return (StatusCode::BAD_REQUEST, axum::Json(body)).into_response();
            }
        }
    }

    // 書込
    let color = body.color.clone().unwrap_or_else(|| "#000000".into());
    let keys = ["glow", "rainbow", "ghost", "chalk", "shield"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let inv_raw: String = u.get(4);
    let mut inv = users::parse_inventory(&inv_raw, &keys);
    let (store_c, store_t, coats, chalk_secs, shield_secs) = match write_pixel(
        &mut tx,
        body.x,
        body.y,
        &color,
        &ink,
        &mut inv,
        &uid,
        &state.cfg,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => return e,
    };

    // 経験値・レベル・クールダウン
    let cooldown = users::cooldown_for_level(
        level,
        state.cfg.cooldown_sec,
        state.cfg.min_cooldown,
        state.cfg.cooldown_decay,
    );
    let cd_new = now + cooldown;
    let mut xp: i64 = u.get::<i32, _>(7) as i64 + state.cfg.xp_per_place;
    let mut lv = level;
    let mut leveled_up = false;
    loop {
        let need = users::xp_needed_for_level(lv, state.cfg.xp_base, state.cfg.xp_pow);
        if xp < need {
            break;
        }
        xp -= need;
        lv += 1;
        leveled_up = true;
    }
    let xp_needed = users::xp_needed_for_level(lv, state.cfg.xp_base, state.cfg.xp_pow);
    // 報酬ガチャ (特殊インクの入手経路。game-rules.md)。
    // ゲーム内ガチャであり秘密情報ではないためrandでよい。
    // ThreadRngは!Sendのため束縛せず都度生成する (await跨ぎ保持の回避)
    let reward: Option<(String, i64)> = {
        let chance = state.cfg.reward_chance.clamp(0.0, 1.0);
        let (lo, hi) = (
            state.cfg.reward_min.max(1).min(state.cfg.reward_max.max(1)),
            state.cfg.reward_min.max(1).max(state.cfg.reward_max.max(1)),
        );
        if chance > 0.0 && rand::thread_rng().gen_range(0.0..1.0) < chance {
            let inks = ["glow", "rainbow", "ghost", "chalk", "shield"];
            let ink = inks[rand::thread_rng().gen_range(0..inks.len())].to_string();
            let amount = rand::thread_rng().gen_range(lo..=hi);
            *inv.entry(ink.clone()).or_insert(0) += amount;
            Some((ink, amount))
        } else {
            None
        }
    };
    let inv_json = serde_json::to_string(&inv).unwrap_or_default();
    let _ = sqlx::query(
        "UPDATE users SET inventory = $1, cooldownUntil = $2, level = $3, xp = $4 WHERE token = $5",
    )
    .bind(&inv_json)
    .bind(cd_new)
    .bind(lv)
    .bind(xp)
    .bind(&token)
    .execute(&mut *tx)
    .await;
    let _ = sqlx::query(
        "INSERT INTO history(x, y, uid, c, t, at, xp, rewardInk, rewardAmount)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    )
    .bind(body.x)
    .bind(body.y)
    .bind(&uid)
    .bind(crate::color::hex_to_int(&store_c).unwrap_or(0xffffff))
    .bind(crate::ws_proto::ink_to_bits(&store_t) as i16)
    .bind(now)
    .bind(state.cfg.xp_per_place)
    .bind(reward.as_ref().map(|(ink, _)| ink.clone()))
    .bind(reward.as_ref().map(|(_, n)| *n).unwrap_or(0))
    .execute(&mut *tx)
    .await;
    let per_cell = state.cfg.max_history_per_cell.clamp(1, 200);
    let _ = sqlx::query(
        "DELETE FROM history WHERE x = $1 AND y = $2 AND id NOT IN
         (SELECT id FROM history WHERE x = $1 AND y = $2 ORDER BY at DESC, id DESC LIMIT $3)",
    )
    .bind(body.x)
    .bind(body.y)
    .bind(per_cell)
    .execute(&mut *tx)
    .await;
    if tx.commit().await.is_err() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "busy");
    }
    maybe_prune(&state.pool, state.cfg.max_history_cells).await;
    state.tiles.bump(body.x, body.y);

    // 購読タイル宛にバイナリ配信 (全員broadcast廃止)
    {
        use crate::tiles::tile_of;
        use crate::ws_proto::{self, ink_to_bits};
        let (r, g, b) = crate::color::hex_to_rgb(&store_c);
        let msg = ws_proto::pixel_bin(
            body.x,
            body.y,
            r,
            g,
            b,
            ink_to_bits(&store_t),
            coats.clamp(0, 5) as u8,
            &uid,
        );
        state.hub.send_to_watchers(tile_of(body.x, body.y), &msg, None);
    }
    let reward_json = reward
        .as_ref()
        .map(|(ink, n)| serde_json::json!({"ink": ink, "amount": n}))
        .unwrap_or(serde_json::Value::Null);
    let body = serde_json::json!({
        "ok": true, "x": body.x, "y": body.y,
        "pixel": {"c": store_c, "t": store_t, "coats": coats,
            "e": chalk_secs, "e0": chalk_secs, "s": shield_secs},
        "by": uid, "cooldownUntil": cd_new, "cooldown": cooldown,
        "inventory": inv, "reward": reward_json,
        "level": lv, "xp": xp, "xpNeeded": xp_needed, "leveledUp": leveled_up,
    });
    (StatusCode::OK, axum::Json(body)).into_response()
}

async fn write_pixel(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    x: i32,
    y: i32,
    color: &str,
    ink: &str,
    inv: &mut std::collections::HashMap<String, i64>,
    uid: &str,
    cfg: &crate::config::Config,
) -> Result<(String, String, i32, f64, f64), Response> {
    if ink == "erase" {
        let _ = sqlx::query("DELETE FROM pixels WHERE x = $1 AND y = $2")
            .bind(x)
            .bind(y)
            .execute(&mut **tx)
            .await;
        return Ok((cfg.background.clone(), "normal".into(), 1, 0.0, 0.0));
    }
    if ink == "normal" {
        let c = color.to_lowercase();
        let ci = crate::color::hex_to_int(&c).unwrap_or(0xffffff);
        let _ = sqlx::query(
            "INSERT INTO pixels(x, y, c, t, by, coats, chalkUntil, shieldUntil)
             VALUES ($1,$2,$3,$4,$5,1,0,0)
             ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t, by=excluded.by,
             coats=1, chalkUntil=0, shieldUntil=0",
        )
        .bind(x)
        .bind(y)
        .bind(ci)
        .bind(0i16)
        .bind(uid)
        .execute(&mut **tx)
        .await;
        return Ok((c, "normal".into(), 1, 0.0, 0.0));
    }
    let need = place_logic::parse_combo_ink(ink).unwrap_or_default();
    if need.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "unknownInk"));
    }
    if need.iter().any(|p| inv.get(p).copied().unwrap_or(0) <= 0) {
        let body =
            serde_json::json!({"ok": false, "error": "noInk", "inventory": inv});
        return Err((StatusCode::CONFLICT, axum::Json(body)).into_response());
    }
    // 既存
    let row = sqlx::query("SELECT c, t, coats FROM pixels WHERE x = $1 AND y = $2")
        .bind(x)
        .bind(y)
        .fetch_optional(&mut **tx)
        .await
        .unwrap_or(None);
    let (base_ci, base_t, base_coats): (Option<i32>, Option<i16>, i32) =
        match row {
            Some(r) => {
                use sqlx::Row;
                (Some(r.get(0)), Some(r.get(1)), r.get::<i16, _>(2) as i32)
            }
            None => (None, None, 1),
        };
    let want_ghost = need.iter().any(|p| p == "ghost");
    let chosen = color.to_lowercase();
    let base_hex = base_ci.map(crate::color::int_to_hex);
    let (store_c, coats) = if need.iter().any(|p| p == "rainbow") {
        let c = base_hex.clone().unwrap_or(chosen.clone());
        (c, if want_ghost { base_coats } else { 1 })
    } else if !want_ghost {
        (chosen.clone(), 1)
    } else if base_t.map(|t| t & 2 != 0).unwrap_or(false) && base_coats >= 1
    {
        (chosen.clone(), (base_coats + 1).min(MAX_GHOST_COATS))
    } else if base_hex.is_none() {
        (chosen.clone(), 1)
    } else {
        let under = base_hex.unwrap_or_else(|| "#ffffff".into());
        (place_logic::blend_hex(&chosen, &under, 0.5), 0)
    };
    let store_t = need.join("+");
    let store_ci = crate::color::hex_to_int(&store_c).unwrap_or(0xffffff);
    let store_ti = crate::ws_proto::ink_to_bits(&store_t) as i16;
    // 期限付与 (チョークは消滅、シールドは保護)。持たない側は0で明示消去
    let now_until = chrono::Utc::now().timestamp() as f64;
    let chalk_until = if need.iter().any(|p| p == "chalk") {
        now_until + cfg.chalk_minutes * 60.0
    } else {
        0.0
    };
    let shield_until = if need.iter().any(|p| p == "shield") {
        now_until + cfg.shield_minutes * 60.0
    } else {
        0.0
    };
    let _ = sqlx::query(
        "INSERT INTO pixels(x, y, c, t, by, coats, chalkUntil, shieldUntil)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(x, y) DO UPDATE SET c=excluded.c, t=excluded.t, by=excluded.by,
         coats=excluded.coats, chalkUntil=excluded.chalkUntil, shieldUntil=excluded.shieldUntil",
    )
    .bind(x)
    .bind(y)
    .bind(store_ci)
    .bind(store_ti)
    .bind(uid)
    .bind(coats as i16)
    .bind(chalk_until)
    .bind(shield_until)
    .execute(&mut **tx)
    .await;
    for p in &need {
        *inv.entry(p.clone()).or_insert(0) -= 1;
    }
    let chalk_secs = if chalk_until > 0.0 {
        cfg.chalk_minutes * 60.0
    } else {
        0.0
    };
    let shield_secs = if shield_until > 0.0 {
        cfg.shield_minutes * 60.0
    } else {
        0.0
    };
    Ok((store_c, store_t, coats, chalk_secs, shield_secs))
}

fn err(status: StatusCode, code: &str) -> Response {
    let body = serde_json::json!({"ok": false, "error": code});
    (status, axum::Json(body)).into_response()
}

/// 履歴セル数の整理。配置トランザクションの外・別Txで低頻度に実行する
/// (Python maybePrune相当。5%サンプリングで全走査を間引く)
async fn maybe_prune(pool: &sqlx::PgPool, max_cells: i64) {
    if max_cells <= 0 {
        return;
    }
    if rand::thread_rng().gen_range(0.0..1.0) >= 0.05 {
        return;
    }
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM (SELECT DISTINCT x, y FROM history) AS t",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    let excess = total - max_cells;
    if excess <= 0 {
        return;
    }
    let _ = sqlx::query(
        "DELETE FROM history WHERE (x, y) IN (
           SELECT x, y FROM (
             SELECT x, y, MAX(id) AS m FROM history
             GROUP BY x, y ORDER BY m ASC LIMIT $1
           ) AS old
         )",
    )
    .bind(excess)
    .execute(pool)
    .await;
}
