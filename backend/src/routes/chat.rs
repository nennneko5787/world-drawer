//! テキストチャット (公開・全員閲覧)。
//! - 送信はRESTのみ (`POST /api/chat {body}`)。WSにchat送信は足さない (placeと同方式)。
//! - 受信はWSバイナリ kind=8 + `GET /api/chat` (履歴・ポーリングfallback)。
//! - 表示名・色・レベルはusersから都度解決する (改名対応。historyと同方式)。
//! - 荒らし対策: ban執行・IP共有バケツ (10通/分)・200文字制限・最新200件保持。

use crate::auth;
use crate::ip;
use crate::rate;
use crate::routes::AppState;
use crate::ws_proto;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::net::SocketAddr;

/// 1通あたりの最大文字数 (フロントのmaxlengthと一致させること)。
pub const CHAT_MAX_CHARS: usize = 200;
/// IP共有の投稿上限 (10通/分。家族利用を妨げない程度に緩め)。
pub const CHAT_PER_MIN: i64 = 10;
pub const CHAT_WINDOW_SEC: f64 = 60.0;
/// サーバー保持件数 (超過分は投稿時に古い方から削除)。
pub const CHAT_KEEP: i64 = 200;

#[derive(Deserialize)]
pub struct ListQ {
    pub limit: Option<i64>,
    #[serde(alias = "beforeId")]
    pub before_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct PostBody {
    #[serde(default)]
    pub body: String,
}

fn err(status: StatusCode, code: &str) -> Response {
    let body = serde_json::json!({"ok": false, "error": code});
    (status, axum::Json(body)).into_response()
}

fn clean_body(raw: &str) -> String {
    // NULはPostgres TEXTに入らない・C0制御は表示が乱れるため除去
    // (改行とタブは残す)。XSS自体はフロントのtextContent描画で封じる。
    raw.chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(CHAT_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// 投稿可否の事前判定。超過は切り詰めず `badBody` で拒否する (spec通り)。
fn body_len_ok(raw: &str) -> bool {
    let t = raw
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect::<String>();
    let n = t.trim().chars().count();
    n >= 1 && n <= CHAT_MAX_CHARS
}

fn row_to_message(
    id: i64,
    uid: String,
    name: String,
    color: i32,
    level: i32,
    body: String,
    at: f64,
) -> serde_json::Value {
    serde_json::json!({
        "id": id, "uid": uid,
        "name": name, "userColor": crate::color::int_to_hex(color),
        "level": level as i64, "body": body, "at": at,
    })
}

/// 履歴。新しい順ではなく古い順 (ASC) で返す (ドックにそのまま追記できる)。
/// `{ok, messages:[{id,uid,name,userColor,level,body,at}], hasMore}`。
/// `limit` 1-100・既定50。`beforeId` 指定時はそのIDより古い分を返す。
pub async fn list(State(state): State<AppState>, Query(q): Query<ListQ>) -> Response {
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let rows = if let Some(b) = q.before_id {
        sqlx::query(
            "SELECT c.id, c.uid, COALESCE(u.name,'ななし'), COALESCE(u.color,2245734),
                    COALESCE(u.level,1), c.body, c.at
             FROM chat c LEFT JOIN users u ON u.uid = c.uid
             WHERE c.id < $1 ORDER BY c.id DESC LIMIT $2",
        )
        .bind(b)
        .bind(limit + 1)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query(
            "SELECT c.id, c.uid, COALESCE(u.name,'ななし'), COALESCE(u.color,2245734),
                    COALESCE(u.level,1), c.body, c.at
             FROM chat c LEFT JOIN users u ON u.uid = c.uid
             ORDER BY c.id DESC LIMIT $1",
        )
        .bind(limit + 1)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    };
    use sqlx::Row;
    let has_more = rows.len() as i64 > limit;
    let mut messages: Vec<_> = rows
        .iter()
        .take(limit as usize)
        .map(|r| {
            row_to_message(
                r.get::<i64, _>(0),
                r.get::<String, _>(1),
                r.get::<String, _>(2),
                r.get::<i32, _>(3),
                r.get::<i32, _>(4),
                r.get::<String, _>(5),
                r.get::<f64, _>(6),
            )
        })
        .collect();
    // DESCで取ってASCに戻す (ドックは上=古い・下=新しい)。
    messages.reverse();
    let body = serde_json::json!({"ok": true, "messages": messages, "hasMore": has_more});
    (StatusCode::OK, axum::Json(body)).into_response()
}

/// 投稿。Bearerのみ。成功時は `{ok, message}` + WS kind=8を全体配信する。
pub async fn post(
    State(mut state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: axum::Json<PostBody>,
) -> Response {
    let Ok(token) = auth::bearer(&headers) else {
        return err(StatusCode::UNAUTHORIZED, "missingToken");
    };
    // IP解決 (trustedProxies経由のみヘッダ信用)
    let nets = ip::parse_nets(&state.cfg.trusted_proxies);
    let client_ip = ip::client_ip_from_headers(&headers, &peer, &nets);

    // ban執行 (配置と同点。Redis障害時は通す)
    if rate::ban_remaining(&mut state.redis, &client_ip).await > 0.0 {
        return err(StatusCode::FORBIDDEN, "banned");
    }
    // IP共有バケツ (試行時計数。placeと同方式)
    if !rate::allow(
        &mut state.redis,
        "chat",
        &client_ip,
        CHAT_PER_MIN,
        CHAT_WINDOW_SEC,
    )
    .await
    {
        let retry = rate::retry_after(&mut state.redis, "chat", &client_ip, CHAT_WINDOW_SEC)
            .await
            .max(0.0);
        let retry_after = (retry * 100.0).round() / 100.0;
        let body =
            serde_json::json!({"ok": false, "error": "rateLimited", "retryAfter": retry_after});
        let mut hdrs = HeaderMap::new();
        hdrs.insert(
            axum::http::header::RETRY_AFTER,
            axum::http::HeaderValue::from_str(&retry.ceil().max(1.0).to_string())
                .unwrap_or(axum::http::HeaderValue::from_static("1")),
        );
        return (StatusCode::TOO_MANY_REQUESTS, hdrs, axum::Json(body)).into_response();
    }

    let text = clean_body(&body.body);
    if text.is_empty() || !body_len_ok(&body.body) {
        return err(StatusCode::BAD_REQUEST, "badBody");
    }

    // 投稿者解決 (表示名・色・レベルは解決時点で確定)
    let user = sqlx::query("SELECT uid, name, color, level FROM users WHERE token = $1")
        .bind(&token)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    let Some(u) = user else {
        return err(StatusCode::NOT_FOUND, "noUser");
    };
    use sqlx::Row;
    let uid: String = u.get(0);
    let name: String = u.get(1);
    let color: i32 = u.get(2);
    let level: i32 = u.get(3);

    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let row = sqlx::query(
        "INSERT INTO chat(uid, body, at) VALUES ($1,$2,$3) RETURNING id, at",
    )
    .bind(&uid)
    .bind(&text)
    .bind(now)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "busy");
    };
    let id: i64 = r.get(0);
    let at: f64 = r.get(1);

    // 保持数整理 (最新200件。失敗しても投稿自体は成功扱い)
    let _ = sqlx::query(
        "DELETE FROM chat WHERE id NOT IN
         (SELECT id FROM chat ORDER BY id DESC LIMIT $1)",
    )
    .bind(CHAT_KEEP)
    .execute(&state.pool)
    .await;

    // 全体配信 (join/leaveと同様にbroadcast。送信者自身にも届く)
    {
        let (rr, gg, bb) = crate::color::hex_to_rgb(&crate::color::int_to_hex(color));
        let msg = ws_proto::chat_bin(id, at, &uid, &name, rr, gg, bb, level as i64, &text);
        state.hub.broadcast_all(&msg, None);
    }
    let out = row_to_message(id, uid, name, color, level, text, at);
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({"ok": true, "message": out})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_trimmed_and_capped() {
        assert_eq!(clean_body("  hi  "), "hi");
        assert_eq!(clean_body(""), "");
        assert_eq!(clean_body("   "), "");
        assert_eq!(clean_body("a\r\nb"), "a\nb");
        let long = "あ".repeat(CHAT_MAX_CHARS + 10);
        assert_eq!(clean_body(&long).chars().count(), CHAT_MAX_CHARS);
        // 超過は切り詰めず拒否 (badBody相当)
        assert!(!body_len_ok(&long));
        assert!(body_len_ok("hi"));
        assert!(!body_len_ok("   "));
        // NUL・C0制御は除去 (Postgres TEXT対策)。改行・タブは残す
        assert_eq!(clean_body("a\0b"), "ab");
        assert_eq!(clean_body("a\x07b"), "ab");
        assert_eq!(clean_body("a\tb\nc"), "a\tb\nc");
        assert!(!body_len_ok("\0"));
        assert!(body_len_ok("a\0b"));
    }
}
