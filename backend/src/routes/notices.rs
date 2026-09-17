//! お知らせ (単一テキスト・管理者投稿・全員閲覧)。
//! GET /api/notices は公開。POST/PUT/DELETE /api/admin/notices* は管理者のみ (UID制)。

use crate::routes::admin::is_admin;
use crate::routes::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct ListQ {
    pub limit: Option<i64>,
}

/// 言語別翻訳1件分。空文字は「未翻訳」(取得時は日本語ベースにfallback)。
#[derive(Deserialize, Default)]
pub struct TranslationBody {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Deserialize)]
pub struct UpsertBody {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// 日本語ベース以外の翻訳 (`{"en":{"title","body"},...}`)。
    #[serde(default)]
    pub translations: HashMap<String, TranslationBody>,
}

/// 正準言語キー。`title`/`body` の日本語ベース (`ja`) 以外のみ受け付ける。
/// `EN`・`zh_cn` 等の揺れを吸収する。対象外はNone。
fn canonical_lang(raw: &str) -> Option<&'static str> {
    let t = raw.trim().to_ascii_lowercase().replace('_', "-");
    match t.as_str() {
        "en" => Some("en"),
        "ko" => Some("ko"),
        "zh-cn" => Some("zh-CN"),
        "zh-tw" => Some("zh-TW"),
        _ => None,
    }
}

fn row_to_notice(
    id: i64,
    title: String,
    body: String,
    translations: serde_json::Value,
    created_at: f64,
    updated_at: f64,
) -> serde_json::Value {
    serde_json::json!({
        "id": id, "title": title, "body": body,
        "translations": translations,
        "createdAt": created_at, "updatedAt": updated_at,
    })
}

/// 保存用の翻訳JSONを作る。両方空の言語・対象外言語は落とす。
fn clean_translations(raw: &HashMap<String, TranslationBody>) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    // 決定的な順序 (en, ko, zh-CN, zh-TW) で入れる。
    // 大文字小文字違いの重複は正準表記 (`en` > `EN`) を優先する。
    let mut items: Vec<(&str, &TranslationBody)> = vec![];
    let mut raws: Vec<(&str, &str)> = vec![];
    for (k, v) in raw {
        if let Some(lang) = canonical_lang(k) {
            items.push((lang, v));
            raws.push((lang, k.as_str()));
        }
    }
    let mut idx: Vec<usize> = (0..items.len()).collect();
    idx.sort_by(|&a, &b| {
        items[a]
            .0
            .cmp(items[b].0)
            .then((raws[a].1 != items[a].0).cmp(&(raws[b].1 != items[b].0)))
    });
    let mut seen: Vec<&str> = vec![];
    for i in idx {
        let (lang, tr) = items[i];
        if seen.contains(&lang) {
            continue;
        }
        seen.push(lang);
        let title = clean_title(&tr.title);
        let body = clean_body(&tr.body);
        if title.is_empty() && body.is_empty() {
            continue;
        }
        map.insert(
            lang.to_string(),
            serde_json::json!({"title": title, "body": body}),
        );
    }
    serde_json::Value::Object(map)
}

fn parse_translations(raw: &str) -> serde_json::Value {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        _ => serde_json::json!({}),
    }
}

/// 公開一覧。新しい順。`{ok, notices:[{id,title,body,translations,createdAt,updatedAt}]}`。
/// `title`/`body` は日本語ベース。表示側は `translations[lang]` があれば使い、
/// 無ければ日本語にフォールバックする。
pub async fn list(State(state): State<AppState>, Query(q): Query<ListQ>) -> Response {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query(
        "SELECT id, title, body, i18n, createdAt, updatedAt FROM notices ORDER BY id DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    use sqlx::Row;
    let notices: Vec<_> = rows
        .iter()
        .map(|r| {
            row_to_notice(
                r.get::<i64, _>(0),
                r.get::<String, _>(1),
                r.get::<String, _>(2),
                parse_translations(&r.get::<String, _>(3)),
                r.get::<f64, _>(4),
                r.get::<f64, _>(5),
            )
        })
        .collect();
    let body = serde_json::json!({"ok": true, "notices": notices});
    (StatusCode::OK, axum::Json(body)).into_response()
}

fn clean_title(s: &str) -> String {
    s.trim().chars().take(200).collect::<String>().trim().to_string()
}

fn clean_body(s: &str) -> String {
    s.trim().chars().take(20000).collect::<String>().trim().to_string()
}

/// 管理者投稿。`{title, body, translations?}` → `{ok, notice}`。
pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::Json<UpsertBody>,
) -> Response {
    if !is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#).into_response();
    }
    let title = clean_title(&body.title);
    let text = clean_body(&body.body);
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            r#"{"ok":false,"error":"badTitle"}"#,
        )
            .into_response();
    }
    let tr = clean_translations(&body.translations);
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let row = sqlx::query(
        "INSERT INTO notices(title, body, i18n, createdAt, updatedAt) VALUES ($1,$2,$3,$4,$4)
         RETURNING id, title, body, i18n, createdAt, updatedAt",
    )
    .bind(&title)
    .bind(&text)
    .bind(tr.to_string())
    .bind(now)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"ok":false,"error":"busy"}"#,
        )
            .into_response();
    };
    use sqlx::Row;
    let out = row_to_notice(
        r.get::<i64, _>(0),
        r.get::<String, _>(1),
        r.get::<String, _>(2),
        parse_translations(&r.get::<String, _>(3)),
        r.get::<f64, _>(4),
        r.get::<f64, _>(5),
    );
    (StatusCode::OK, axum::Json(serde_json::json!({"ok": true, "notice": out}))).into_response()
}

/// 管理者編集。`PUT /api/admin/notices/:id {title, body, translations?}`。
pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: axum::Json<UpsertBody>,
) -> Response {
    if !is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#).into_response();
    }
    let title = clean_title(&body.title);
    let text = clean_body(&body.body);
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            r#"{"ok":false,"error":"badTitle"}"#,
        )
            .into_response();
    }
    let tr = clean_translations(&body.translations);
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    let row = sqlx::query(
        "UPDATE notices SET title = $1, body = $2, i18n = $3, updatedAt = $4 WHERE id = $5
         RETURNING id, title, body, i18n, createdAt, updatedAt",
    )
    .bind(&title)
    .bind(&text)
    .bind(tr.to_string())
    .bind(now)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some(r) = row else {
        return (
            StatusCode::OK,
            r#"{"ok":false,"error":"noNotice"}"#,
        )
            .into_response();
    };
    use sqlx::Row;
    let out = row_to_notice(
        r.get::<i64, _>(0),
        r.get::<String, _>(1),
        r.get::<String, _>(2),
        parse_translations(&r.get::<String, _>(3)),
        r.get::<f64, _>(4),
        r.get::<f64, _>(5),
    );
    (StatusCode::OK, axum::Json(serde_json::json!({"ok": true, "notice": out}))).into_response()
}

/// 管理者削除。`DELETE /api/admin/notices/:id`。
pub async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    if !is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#).into_response();
    }
    let done = sqlx::query("DELETE FROM notices WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await;
    match done {
        Ok(r) if r.rows_affected() == 1 => (
            StatusCode::OK,
            axum::Json(serde_json::json!({"ok": true, "id": id})),
        )
            .into_response(),
        _ => (StatusCode::OK, r#"{"ok":false,"error":"noNotice"}"#).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr_map(pairs: &[(&str, &str, &str)]) -> HashMap<String, TranslationBody> {
        pairs
            .iter()
            .map(|(l, t, b)| {
                (
                    l.to_string(),
                    TranslationBody {
                        title: t.to_string(),
                        body: b.to_string(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn lang_keys_normalized() {
        assert_eq!(canonical_lang("en"), Some("en"));
        assert_eq!(canonical_lang(" EN "), Some("en"));
        assert_eq!(canonical_lang("zh-cn"), Some("zh-CN"));
        assert_eq!(canonical_lang("zh_CN"), Some("zh-CN"));
        assert_eq!(canonical_lang("zh-TW"), Some("zh-TW"));
        assert_eq!(canonical_lang("ja"), None);
        assert_eq!(canonical_lang("fr"), None);
        assert_eq!(canonical_lang(""), None);
    }

    #[test]
    fn translations_cleaned_and_filtered() {
        let v = clean_translations(&tr_map(&[
            ("en", " Hello ", "World"),
            ("EN", "dup", "dropped"),
            ("ja", "日本語", "無視される"),
            ("fr", "x", "対象外"),
            ("ko", "  ", ""),
        ]));
        assert_eq!(v["en"]["title"], "Hello");
        assert_eq!(v["en"]["body"], "World");
        assert!(v.get("ja").is_none());
        assert!(v.get("fr").is_none());
        // 両方空は落とす
        assert!(v.get("ko").is_none());
        // 長さ制限が効く
        let long = "a".repeat(300);
        let v2 = clean_translations(&tr_map(&[("en", &long, "b")]));
        assert_eq!(v2["en"]["title"].as_str().unwrap().chars().count(), 200);
    }

    #[test]
    fn broken_i18n_falls_back_to_empty() {
        assert_eq!(parse_translations("not json"), serde_json::json!({}));
        assert_eq!(parse_translations("[1,2]"), serde_json::json!({}));
        assert_eq!(
            parse_translations(r#"{"en":{"title":"t","body":"b"}}"#)["en"]["title"],
            "t"
        );
    }
}
