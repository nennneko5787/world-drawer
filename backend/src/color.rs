//! カラーはDB上でINTEGER (0xRRGGBB) として持つ。
//! API契約は `#rrggbb` hex文字列のまま (フロント churn 回避のため
//! サーバ側で相互変換)。WSバイナリは r,g,b 3B のまま。
//!
//! 削減見積り (正直な数字):
//! - heap の c 列: 約8B → 4B で約4B/行
//! - idx_pixels_box の c 含み: 約4B/エントリ
//! - 合計約8B/行、行全体 (~70B+ヘッダ) の1割弱。100万行で約8MB。
//! - JSON API は `"c":"#ffffff"`(12B) → 変換後はサーバ側でhexに戻すため不変。
//!   brotli後はほぼ誤差。WSは既に3B。
//! よって負荷の本丸 (broadcast/全行fetch) 対策済みの今となっては小粒。
//! users.color (プロフィール色・微量) は TEXT のまま対象外。

/// 0xRRGGBB (下位24bitのみ有効)。
pub fn rgb_to_int(r: u8, g: u8, b: u8) -> i32 {
    ((r as u32) << 16 | (g as u32) << 8 | b as u32) as i32
}

pub fn int_to_rgb(n: i32) -> (u8, u8, u8) {
    let u = (n as u32) & 0xffffff;
    (
        ((u >> 16) & 0xff) as u8,
        ((u >> 8) & 0xff) as u8,
        (u & 0xff) as u8,
    )
}

/// `#rrggbb` → 0xRRGGBB (i32)。不正時は None。
pub fn hex_to_int(s: &str) -> Option<i32> {
    let b = s.as_bytes();
    if b.len() != 7 || b[0] != b'#' {
        return None;
    }
    let p = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).ok();
    let (r, g, bl) = (p(1)?, p(3)?, p(5)?);
    Some(rgb_to_int(r, g, bl))
}

/// `#rrggbb` → (r,g,b)。不正時は (0,0,0)。
pub fn hex_to_rgb(s: &str) -> (u8, u8, u8) {
    match hex_to_int(s) {
        Some(n) => int_to_rgb(n),
        None => (0, 0, 0),
    }
}

/// 0xRRGGBB → `#rrggbb` (小文字正準形)。
pub fn int_to_hex(n: i32) -> String {
    format!("#{:06x}", (n as u32) & 0xffffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        assert_eq!(hex_to_int("#000000"), Some(0));
        assert_eq!(hex_to_int("#ffffff"), Some(0xffffff));
        assert_eq!(hex_to_int("#FFFFFF"), Some(0xffffff));
        assert_eq!(hex_to_int("#22aa66"), Some(0x22aa66));
        assert_eq!(hex_to_int("nope"), None);
        assert_eq!(hex_to_int("#12345"), None);
        assert_eq!(hex_to_int("#gggggg"), None);
    }

    #[test]
    fn int_roundtrip() {
        assert_eq!(int_to_hex(0), "#000000");
        assert_eq!(int_to_hex(0xffffff), "#ffffff");
        assert_eq!(int_to_rgb(rgb_to_int(0x22, 0xaa, 0x66)), (0x22, 0xaa, 0x66));
        assert_eq!(hex_to_rgb("#22aa66"), (0x22, 0xaa, 0x66));
        assert_eq!(hex_to_rgb("bogus"), (0, 0, 0));
        // hex -> int -> hex
        for s in ["#000000", "#ffffff", "#22aa66", "#a1b2c3"] {
            let n = hex_to_int(s).unwrap();
            assert_eq!(int_to_hex(n), s);
        }
    }
}
