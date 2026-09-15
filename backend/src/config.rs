//! 設定 (`config.jsonc` + `config.local.jsonc` を後勝ちマージ)。
//! Python版と同キー。追加: `turnstile`, `listen`, `corsOrigins`, `siteUrl`必須化寄り。

use anyhow::Context;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnstileCfg {
    #[serde(default = "default_true")]
    pub enforce: bool,
    #[serde(default)]
    pub site_key: String,
    #[serde(default)]
    pub secret_key: String,
    #[serde(default = "default_timeout")]
    pub timeout_sec: u64,
}

fn default_true() -> bool {
    true
}
fn default_timeout() -> u64 {
    5
}
fn default_listen() -> String {
    "127.0.0.1:5787".to_string()
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default, alias = "database_url")]
    pub database_url: String,
    #[serde(default, alias = "redis_url")]
    pub redis_url: String,
    #[serde(default = "default_listen")]
    pub listen: String,
    #[serde(default, alias = "site_url")]
    pub site_url: String,
    #[serde(default, alias = "cors_origins")]
    pub cors_origins: Vec<String>,
    #[serde(default, alias = "admin_tokens")]
    pub admin_tokens: Vec<String>,
    #[serde(default, alias = "trusted_proxies")]
    pub trusted_proxies: Vec<String>,
    #[serde(default)]
    pub turnstile: Option<TurnstileCfg>,
    // ゲームバランス (既定はPython版と同一)
    #[serde(default = "d5", alias = "cooldown_sec")]
    pub cooldown_sec: f64,
    #[serde(default = "d1", alias = "min_cooldown")]
    pub min_cooldown: f64,
    #[serde(default = "d087", alias = "cooldown_decay")]
    pub cooldown_decay: f64,
    #[serde(default = "d100k", alias = "max_bbox_pixels")]
    pub max_bbox_pixels: usize,
    #[serde(default = "d1i", alias = "xp_per_place")]
    pub xp_per_place: i64,
    #[serde(default = "d3f", alias = "xp_base")]
    pub xp_base: f64,
    #[serde(default = "d15", alias = "xp_pow")]
    pub xp_pow: f64,
    #[serde(default = "dffffff")]
    pub background: String,
    #[serde(default = "d5i", alias = "trusted_level")]
    pub trusted_level: i64,
    #[serde(default = "d1000i", alias = "place_radius")]
    pub place_radius: i32,
}

fn d5() -> f64 {
    5.0
}
fn d1() -> f64 {
    1.0
}
fn d087() -> f64 {
    0.87
}
fn d100k() -> usize {
    100000
}
fn d1i() -> i64 {
    1
}
fn d3f() -> f64 {
    3.0
}
fn d15() -> f64 {
    1.5
}
fn dffffff() -> String {
    "#ffffff".to_string()
}
fn d5i() -> i64 {
    5
}
fn d1000i() -> i32 {
    1000
}

impl Config {
    pub fn cors_origins(&self) -> Vec<axum::http::HeaderValue> {
        self.cors_origins
            .iter()
            .filter_map(|s| s.parse().ok())
            .collect()
    }
}

fn strip_jsonc(text: &str) -> String {
    // // と /* */ を除去 (文字列内は保持)。Python版stripJsoncの簡易移植。
    let mut out = String::with_capacity(text.len());
    let b = text.as_bytes();
    let mut i = 0;
    let mut in_str = false;
    let mut esc = false;
    while i < b.len() {
        let c = b[i] as char;
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < b.len() && (b[i + 1] == b'/' || b[i + 1] == b'*') {
            if b[i + 1] == b'/' {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            } else {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// `}` `]` 直前の余分なカンマを除去 (文字列リテラル内は保持)。
fn remove_trailing_commas(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let b = text.as_bytes();
    let mut i = 0;
    let mut in_str = false;
    let mut esc = false;
    while i < b.len() {
        let c = b[i] as char;
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < b.len() && (b[j] as char).is_whitespace() {
                j += 1;
            }
            if j < b.len() && (b[j] == b'}' || b[j] == b']') {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn empty_object() -> serde_json::Value {
    serde_json::Value::Object(Default::default())
}

fn read_one(path: &PathBuf) -> serde_json::Value {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return empty_object(),
    };
    let cleaned = remove_trailing_commas(&strip_jsonc(&raw));
    match serde_json::from_str::<serde_json::Value>(&cleaned) {
        Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        Ok(_) => {
            tracing::warn!("{} root must be an object, using defaults", path.display());
            empty_object()
        }
        Err(e) => {
            tracing::warn!("{} parse error, using defaults: {e}", path.display());
            empty_object()
        }
    }
}

fn deep_merge(mut a: serde_json::Value, b: serde_json::Value) -> serde_json::Value {
    match (&mut a, b) {
        (serde_json::Value::Object(ma), serde_json::Value::Object(mb)) => {
            for (k, v) in mb {
                let base = ma.remove(&k).unwrap_or(serde_json::Value::Null);
                ma.insert(k, deep_merge(base, v));
            }
            a
        }
        (_, b) => b,
    }
}

pub fn load() -> anyhow::Result<Config> {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        if !url.trim().is_empty() {
            let cfg = Config {
                database_url: url,
                ..Default::default()
            };
            return Ok(cfg);
        }
    }
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("config.jsonc");
    let local = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("config.local.jsonc");
    let merged = deep_merge(read_one(&base), read_one(&local));
    let mut cfg: Config =
        serde_json::from_value(merged).context("config.jsonc parse error")?;
    if let Ok(url) = std::env::var("DATABASE_URL") {
        if !url.trim().is_empty() {
            cfg.database_url = url;
        }
    }
    if cfg.database_url.trim().is_empty() {
        anyhow::bail!("DATABASE_URL/config databaseUrl is required (postgres only)");
    }
    if let Some(t) = &cfg.turnstile {
        if t.enforce && t.secret_key.trim().is_empty() {
            anyhow::bail!("turnstile.enforce=true but secretKey is empty");
        }
    }
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_comma_and_comments() {
        let text = "{\n// c\n\"siteUrl\": \"https://x.example\",\n\"corsOrigins\": [],\n}";
        let v: serde_json::Value =
            serde_json::from_str(&remove_trailing_commas(&strip_jsonc(text))).unwrap();
        assert_eq!(v["siteUrl"], "https://x.example");
    }
}
