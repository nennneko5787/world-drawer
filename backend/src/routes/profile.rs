use crate::auth;
use crate::routes::AppState;
use crate::users;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub show_country: Option<bool>,
}

#[derive(Deserialize)]
pub struct LookupQuery {
    pub uid: String,
}

/// 公開プロフィール (認証不要)。一覧系の名前クリックから開く。
/// `GET /api/profile?uid=` →
/// `{ok, user:{uid,name,color,level,xp,country,registeredAt,placedTotal,rank}}`。
/// `registeredAt` は登録epoch秒 (不明はnull。008以前の既存行は履歴推定で補完)。
/// `placedTotal` は有効履歴件数 (取り消し分を除く。prune既定無効のためほぼ累計)。
/// `rank` は自分より上位の人数+1 (level DESC, xp DESC)。
pub async fn lookup(
    State(state): State<AppState>,
    Query(q): Query<LookupQuery>,
) -> Response {
    let Some(uid) = crate::config::normalize_target_uid(&q.uid) else {
        return (StatusCode::OK, r#"{"ok":false,"error":"noUser"}"#).into_response();
    };
    let row = sqlx::query(
        "SELECT uid, name, color, level, xp, country, showCountry, createdAt
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
    let level = r.get::<i32, _>(3) as i64;
    let xp = r.get::<i32, _>(4) as i64;
    let placed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history WHERE uid = $1 AND NOT undone",
    )
    .bind(&uid)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    let above: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users WHERE level > $1 OR (level = $1 AND xp > $2)",
    )
    .bind(level as i32)
    .bind(xp as i32)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    let show: i32 = r.get(6);
    let out = serde_json::json!({"ok": true, "user": {
        "uid": r.get::<String, _>(0), "name": r.get::<String, _>(1),
        "color": crate::color::int_to_hex(r.get::<i32, _>(2)),
        "level": level, "xp": xp,
        "country": if show != 0 { r.get::<Option<String>, _>(5) } else { None },
        "registeredAt": r.get::<Option<f64>, _>(7),
        "placedTotal": placed, "rank": above + 1,
    }});
    (StatusCode::OK, axum::Json(out)).into_response()
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<Body>,
) -> Response {
    let Ok(token) = auth::bearer(&headers) else {
        return (StatusCode::UNAUTHORIZED, r#"{"ok":false,"error":"missingToken"}"#)
            .into_response();
    };
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
    let row = sqlx::query(
        "SELECT name, color, showCountry, country FROM users WHERE token = $1 FOR UPDATE",
    )
    .bind(&token)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (StatusCode::NOT_FOUND, r#"{"ok":false,"error":"noUser"}"#).into_response();
    };
    use sqlx::Row;
    let cur_color = crate::color::int_to_hex(r.get::<i32, _>(1));
    let cur_show: i32 = r.get(2);
    let cur_country: Option<String> = r.get(3);
    let new_name = users::clean_name(&body.name, 20, "ななし");
    let new_color = users::clean_color(&body.color, &cur_color);
    let new_show = body.show_country.unwrap_or(cur_show != 0);
    let _ = sqlx::query(
        "UPDATE users SET name = $1, color = $2, showCountry = $3 WHERE token = $4",
    )
    .bind(&new_name)
    .bind(crate::color::hex_to_int(&new_color).unwrap_or(0x22aa66))
    .bind(if new_show { 1 } else { 0 })
    .bind(&token)
    .execute(&mut *tx)
    .await;
    if tx.commit().await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"ok":false,"error":"busy"}"#,
        )
            .into_response();
    }
    let out = serde_json::json!({"ok": true, "profile": {
        "name": new_name, "color": new_color,
        "country": cur_country, "showCountry": new_show,
    }});
    (StatusCode::OK, axum::Json(out)).into_response()
}
