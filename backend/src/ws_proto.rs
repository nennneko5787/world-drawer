//! WSバイナリプロトコル (素WebSocketのBinaryフレーム。gRPCではない)。
//!
//! gRPC(grpc-web)が不適な理由:
//! - ブラウザは生gRPCを喋れずproxy必須。unary/streamともHTTPラッパの分だけ重い
//! - 15〜20Bの固定長微小メッセージにprotobufのタグ・可変長・codegenは過剰
//! - 配信はpub/subファンアウトでRPCですらない
//! よって手詰め固定長フレームにする。JSON比でpixel約110B→20B、cursor約90B→15B。

/// kindバイト
pub const K_PIXEL: u8 = 1;
pub const K_CURSOR: u8 = 2;
pub const K_LEAVE: u8 = 3;

/// ink正準形 ("ghost+glow"等) → bitmask。
/// chalk=1 ghost=2 glow=4 rainbow=8 shield=16、normal/空=0、erase=0x20。
/// ビット順は正準ソート順 (alphabetical) と一致させてある
pub fn ink_to_bits(t: &str) -> u8 {
    if t.is_empty() || t == "normal" {
        return 0;
    }
    if t == "erase" {
        return 0x20;
    }
    let mut b = 0u8;
    for p in t.split('+') {
        match p {
            "chalk" => b |= 1,
            "ghost" => b |= 2,
            "glow" => b |= 4,
            "rainbow" => b |= 8,
            "shield" => b |= 16,
            _ => return 0,
        }
    }
    b
}

/// pixel 20B: [kind, x4, y4, r,g,b, ink, coats, uid6]
pub fn pixel_bin(x: i32, y: i32, r: u8, g: u8, b: u8, ink: u8, coats: u8, uid: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(20);
    v.push(K_PIXEL);
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.push(r);
    v.push(g);
    v.push(b);
    v.push(ink);
    v.push(coats);
    push_uid(&mut v, uid, 20);
    v
}

/// cursor 15B: [kind, x4, y4, uid6]
pub fn cursor_bin(x: i32, y: i32, uid: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(15);
    v.push(K_CURSOR);
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    push_uid(&mut v, uid, 15);
    v
}

/// leave 7B: [kind, uid6]
pub fn leave_bin(uid: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(7);
    v.push(K_LEAVE);
    push_uid(&mut v, uid, 7);
    v
}

fn push_uid(v: &mut Vec<u8>, uid: &str, target: usize) {
    let b = uid.as_bytes();
    let n = b.len().min(6);
    v.extend_from_slice(&b[..n]);
    while v.len() < target {
        v.push(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ink_roundtrip_order() {
        assert_eq!(ink_to_bits("ghost+glow"), 2 | 4);
        assert_eq!(ink_to_bits("normal"), 0);
        assert_eq!(ink_to_bits("erase"), 0x20);
        assert_eq!(ink_to_bits("bogus"), 0);
    }

    #[test]
    fn frame_sizes() {
        assert_eq!(pixel_bin(1, -2, 255, 0, 0, 6, 1, "abcdef").len(), 20);
        assert_eq!(cursor_bin(1, 2, "abcdef").len(), 15);
        assert_eq!(leave_bin("abcdef").len(), 7);
    }
}
