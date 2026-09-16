//! 配置・取消のドメインロジック (Python canvas.py の移植)。
//! 検証は落とさない: 境界・色・インク正準形・シールド・クールダウン・半径。

use std::collections::HashSet;

pub const VALID_INKS: &[&str] = &["glow", "rainbow", "ghost", "chalk", "shield"];
pub const MAX_GHOST_COATS: i32 = 5;

/// カーソル照合 (Python canvas.py の CURSOR_FRESH_SEC / CURSOR_MAX_DIST と同値)。
/// 配置点からチェビシェフ距離16以内・5秒以内のカーソル到達を要求する。
pub const CURSOR_FRESH_SEC: f64 = 5.0;
pub const CURSOR_MAX_DIST: i32 = 16;
/// 不一致時の再判定待ち (Python CURSOR_WAIT_SEC と同値)
pub const CURSOR_WAIT_MS: u64 = 350;

pub fn in_bounds(x: i32, y: i32, limit: i32) -> bool {
    x.abs() <= limit && y.abs() <= limit
}

/// "glow+ghost" → ["ghost","glow"] 正準ソート。NGならNone。
pub fn parse_combo_ink(ink: &str) -> Option<Vec<String>> {
    let parts: Vec<&str> = ink.split('+').collect();
    if parts.is_empty() || parts.iter().any(|p| !VALID_INKS.contains(p)) {
        return None;
    }
    let set: HashSet<&str> = parts.iter().copied().collect();
    if set.len() != parts.len() {
        return None;
    }
    let mut v: Vec<String> = set.into_iter().map(|s| s.to_string()).collect();
    v.sort();
    Some(v)
}

pub fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// ゴースト混色 (#rrggbb alpha合成)。
pub fn blend_hex(over: &str, under: &str, alpha: f64) -> String {
    let p = |s: &str, i: usize| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0) as f64;
    let o = over.trim_start_matches('#');
    let u = under.trim_start_matches('#');
    if o.len() != 6 || u.len() != 6 {
        return over.to_string();
    }
    let m = [0, 2, 4].map(|i| (p(o, i) * alpha + p(u, i) * (1.0 - alpha)).round() as u8);
    format!("#{:02x}{:02x}{:02x}", m[0], m[1], m[2])
}
