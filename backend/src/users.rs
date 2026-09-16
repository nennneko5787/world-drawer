//! ドメインロジック (Python users.py の移植)。
//! 検証ルールはそのまま: 名前改行除去+切詰、色#rrggbb、レベル下限1のみ。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const UID_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
pub const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

pub fn clean_name(raw: &str, max_len: usize, fallback: &str) -> String {
    let s: String = raw
        .chars()
        .filter(|&c| c != '\n' && c != '\r')
        .collect();
    let t = s.trim();
    let cut: String = t.chars().take(max_len).collect();
    let cut = cut.trim().to_string();
    if cut.is_empty() {
        fallback.to_string()
    } else {
        cut
    }
}

pub fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 7 || b[0] != b'#' {
        return false;
    }
    b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

pub fn clean_color(raw: &str, fallback: &str) -> String {
    if is_hex_color(raw) {
        return raw.to_lowercase();
    }
    if is_hex_color(fallback) {
        return fallback.to_lowercase();
    }
    "#22aa66".to_string()
}

pub fn clamp_level(level: i64) -> i64 {
    level.max(1)
}

pub fn cooldown_for_level(level: i64, base: f64, min: f64, decay: f64) -> f64 {
    let lv = clamp_level(level) as f64;
    let gap = base - min;
    (min + gap * decay.powf(lv - 1.0)).max(min)
}

pub fn xp_needed_for_level(level: i64, base: f64, pow: f64) -> i64 {
    let lv = clamp_level(level) as f64;
    ((base * lv.powf(pow)) as i64).max(1)
}

/// そのアカウントが今まで稼いだ総経験値 (Python totalEarnedFor相当)
pub fn total_earned(level: i64, xp: i64, base: f64, pow: f64) -> i64 {
    let mut total = xp.max(0);
    let mut lv = 1;
    while lv < clamp_level(level) {
        total += xp_needed_for_level(lv, base, pow);
        lv += 1;
    }
    total
}

/// 総経験値から (level, xp) を再計算 (Python levelXpFromTotal相当)
pub fn level_xp_from_total(total: i64, base: f64, pow: f64) -> (i64, i64) {
    let mut rest = total.max(0);
    let mut level = 1;
    for _ in 0..100000 {
        let need = xp_needed_for_level(level, base, pow);
        if rest < need {
            break;
        }
        rest -= need;
        level += 1;
    }
    (level, rest)
}

pub fn parse_inventory(raw: &str, keys: &[String]) -> HashMap<String, i64> {
    let mut out = HashMap::new();
    for k in keys {
        out.insert(k.clone(), 0);
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return out;
    };
    let Some(map) = v.as_object() else {
        return out;
    };
    for k in keys {
        if let Some(n) = map.get(k).and_then(|x| x.as_i64()) {
            out.insert(k.clone(), n.max(0));
        }
    }
    out
}

pub fn gen_uid() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| {
            let i = rng.gen_range(0..UID_ALPHABET.len());
            UID_ALPHABET[i] as char
        })
        .collect()
}

pub fn gen_transfer_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let part = |rng: &mut rand::rngs::ThreadRng| {
        (0..4)
            .map(|_| {
                let i = rng.gen_range(0..CODE_ALPHABET.len());
                CODE_ALPHABET[i] as char
            })
            .collect::<String>()
    };
    format!("{}-{}", part(&mut rng), part(&mut rng))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub token: String,
    pub uid: String,
    pub name: String,
    pub color: String,
    pub inventory: HashMap<String, i64>,
    pub cooldown_until: f64,
    pub level: i64,
    pub xp: i64,
    pub transfer_code: Option<String>,
    pub has_account: bool,
    pub country: Option<String>,
    pub show_country: bool,
}
