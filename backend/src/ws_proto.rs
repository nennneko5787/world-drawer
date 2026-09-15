//! WSバイナリプロトコル (素WebSocketのBinaryフレーム。gRPCではない)。
//!
//! 完全バイナリ: pixel/cursor/leave だけでなく hello/watch/helloOk/join も
//! Binaryフレーム。Textフレームは送受信ともに使わない。
//!
//! gRPC(grpc-web)が不適な理由:
//! - ブラウザは生gRPCを喋れずproxy必須。unary/streamともHTTPラッパの分だけ重い
//! - 15〜20Bの固定長微小メッセージにprotobufのタグ・可変長・codegenは過剰
//! - 配信はpub/subファンアウトでRPCですらない
//! よって手詰めフレームにする。JSON比でpixel約110B→20B、cursor約90B→15B。
//!
//! kindバイト:
//! - 1 pixel (S→C 20B固定): [1, x4, y4, r,g,b, ink, coats, uid6]
//! - 2 cursor (双方向 15B固定): [2, x4, y4, uid6]
//!     C→S時はuid部無視 (認証済みuidを使う)。S→C時は送信者uid
//! - 3 leave (S→C 7B固定): [3, uid6]
//! - 4 hello (C→S 可変): [4, tlen u16, ticket, slen u16, turnstileToken]
//! - 5 watch (C→S 可変): [5, count u16, (tx i32, ty i32)×count]
//! - 6 helloOk (S→C 9B固定): [6, ok, err, uid6]
//!     err: 0=none 1=badTicket 2=turnstileRequired 3=noUser
//! - 7 join (S→C 可変): [7, uid6, namelen u8, name, r,g,b, level u16]

/// kindバイト
pub const K_PIXEL: u8 = 1;
pub const K_CURSOR: u8 = 2;
pub const K_LEAVE: u8 = 3;
pub const K_HELLO: u8 = 4;
pub const K_WATCH: u8 = 5;
pub const K_HELLO_OK: u8 = 6;
pub const K_JOIN: u8 = 7;

/// hello失敗理由 (HELLO_OK errcode)
pub const HELLO_ERR_NONE: u8 = 0;
pub const HELLO_ERR_BAD_TICKET: u8 = 1;
pub const HELLO_ERR_TURNSTILE: u8 = 2;
pub const HELLO_ERR_NO_USER: u8 = 3;

/// watchのタイル数上限 (interest管理の外枠)
pub const WATCH_TILE_CAP: usize = 512;

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

/// bitmask → ink正準形。ink_to_bits の逆 (DBのt列読み用)。
/// ビット順はalphabetical (正準ソート順) に戻す。
pub fn bits_to_ink(b: i16) -> String {
    let b = b as u8;
    if b & 0x20 != 0 {
        return "erase".into();
    }
    let mut parts = vec![];
    if b & 1 != 0 {
        parts.push("chalk");
    }
    if b & 2 != 0 {
        parts.push("ghost");
    }
    if b & 4 != 0 {
        parts.push("glow");
    }
    if b & 8 != 0 {
        parts.push("rainbow");
    }
    if b & 16 != 0 {
        parts.push("shield");
    }
    if parts.is_empty() {
        "normal".into()
    } else {
        parts.join("+")
    }
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

/// hello 送信側ビルダー (テスト・ツール用。フロントはJSで同レイアウトを組む)
#[allow(dead_code)] // フロント側コーデック。対称性の文書化+テスト用に温存
pub fn hello_bin(ticket: &str, ts: &str) -> Vec<u8> {
    let tb = ticket.as_bytes();
    let sb = ts.as_bytes();
    let mut v = Vec::with_capacity(5 + tb.len() + sb.len());
    v.push(K_HELLO);
    v.extend_from_slice(&(tb.len() as u16).to_le_bytes());
    v.extend_from_slice(tb);
    v.extend_from_slice(&(sb.len() as u16).to_le_bytes());
    v.extend_from_slice(sb);
    v
}

/// HELLO解釈 → (ticket, turnstileToken)。不正・範囲外はNone
pub fn parse_hello(b: &[u8]) -> Option<(String, String)> {
    if b.len() < 5 || b[0] != K_HELLO {
        return None;
    }
    let tlen = u16::from_le_bytes([b[1], b[2]]) as usize;
    if tlen == 0 || tlen > 128 {
        return None;
    }
    if b.len() < 3 + tlen + 2 {
        return None;
    }
    let o = 3 + tlen;
    let slen = u16::from_le_bytes([b[o], b[o + 1]]) as usize;
    if slen > 4096 || b.len() != o + 2 + slen {
        return None;
    }
    let ticket = std::str::from_utf8(&b[3..3 + tlen]).ok()?.to_string();
    let ts = std::str::from_utf8(&b[o + 2..o + 2 + slen])
        .ok()
        .unwrap_or("")
        .to_string();
    Some((ticket, ts))
}

/// watch 送信側ビルダー (テスト・ツール用。512上限で切る)
#[allow(dead_code)] // フロント側コーデック。対称性の文書化+テスト用に温存
pub fn watch_bin(tiles: &[(i32, i32)]) -> Vec<u8> {
    let n = tiles.len().min(WATCH_TILE_CAP);
    let mut v = Vec::with_capacity(3 + n * 8);
    v.push(K_WATCH);
    v.extend_from_slice(&(n as u16).to_le_bytes());
    for (tx, ty) in &tiles[..n] {
        v.extend_from_slice(&tx.to_le_bytes());
        v.extend_from_slice(&ty.to_le_bytes());
    }
    v
}

/// WATCH解釈 → 購読タイル。512上限・範囲外除外。不正はNone
pub fn parse_watch(b: &[u8]) -> Option<Vec<(i32, i32)>> {
    if b.len() < 3 || b[0] != K_WATCH {
        return None;
    }
    let n = u16::from_le_bytes([b[1], b[2]]) as usize;
    if n > WATCH_TILE_CAP || b.len() != 3 + n * 8 {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let o = 3 + i * 8;
        let tx = i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let ty = i32::from_le_bytes([b[o + 4], b[o + 5], b[o + 6], b[o + 7]]);
        if tx.abs() <= 20000 && ty.abs() <= 20000 {
            out.push((tx, ty));
        }
    }
    Some(out)
}

/// HELLO_OK 9B: [6, ok, err, uid6]
pub fn hello_ok_bin(ok: bool, err: u8, uid: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(9);
    v.push(K_HELLO_OK);
    v.push(ok as u8);
    v.push(err);
    push_uid(&mut v, uid, 9);
    v
}

/// HELLO_OK解釈 → (ok, err, uid)
#[allow(dead_code)] // フロント側コーデック。対称性の文書化+テスト用に温存
pub fn parse_hello_ok(b: &[u8]) -> Option<(bool, u8, String)> {
    if b.len() != 9 || b[0] != K_HELLO_OK {
        return None;
    }
    let uid = std::str::from_utf8(&b[3..9])
        .ok()
        .unwrap_or("")
        .trim_matches('\0')
        .to_string();
    Some((b[1] != 0, b[2], uid))
}

/// JOIN可変長: [7, uid6, namelen u8, name, r,g,b, level u16]
pub fn join_bin(uid: &str, name: &str, r: u8, g: u8, bcol: u8, level: i64) -> Vec<u8> {
    let nb = name.as_bytes();
    let mut n = nb.len().min(200);
    while n > 0 && !name.is_char_boundary(n) {
        n -= 1;
    }
    let mut v = Vec::with_capacity(8 + n + 5);
    v.push(K_JOIN);
    push_uid(&mut v, uid, 7);
    v.push(n as u8);
    v.extend_from_slice(&nb[..n]);
    v.push(r);
    v.push(g);
    v.push(bcol);
    v.extend_from_slice(&(level.clamp(1, 65535) as u16).to_le_bytes());
    v
}

/// JOIN解釈 → (uid, name, (r,g,b), level)
#[allow(dead_code)] // フロント側コーデック。対称性の文書化+テスト用に温存
pub fn parse_join(b: &[u8]) -> Option<(String, String, (u8, u8, u8), i64)> {
    if b.len() < 17 || b[0] != K_JOIN {
        return None;
    }
    let uid = std::str::from_utf8(&b[1..7])
        .ok()
        .unwrap_or("")
        .trim_matches('\0')
        .to_string();
    let nl = b[7] as usize;
    if b.len() != 8 + nl + 5 {
        return None;
    }
    let name = std::str::from_utf8(&b[8..8 + nl]).ok()?.to_string();
    let o = 8 + nl;
    let level = u16::from_le_bytes([b[o + 3], b[o + 4]]) as i64;
    Some((uid, name, (b[o], b[o + 1], b[o + 2]), level))
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
    fn bits_roundtrip() {
        for s in [
            "normal",
            "erase",
            "chalk",
            "ghost",
            "glow",
            "rainbow",
            "shield",
            "chalk+ghost",
            "ghost+glow",
            "chalk+ghost+glow+rainbow+shield",
        ] {
            assert_eq!(bits_to_ink(ink_to_bits(s) as i16), s);
        }
        assert_eq!(bits_to_ink(0), "normal");
    }

    #[test]
    fn frame_sizes() {
        assert_eq!(pixel_bin(1, -2, 255, 0, 0, 6, 1, "abcdef").len(), 20);
        assert_eq!(cursor_bin(1, 2, "abcdef").len(), 15);
        assert_eq!(leave_bin("abcdef").len(), 7);
        assert_eq!(hello_ok_bin(true, 0, "abcdef").len(), 9);
    }

    #[test]
    fn hello_roundtrip() {
        let b = hello_bin("t_abc123", "ts-token-xyz");
        assert_eq!(
            parse_hello(&b),
            Some(("t_abc123".into(), "ts-token-xyz".into()))
        );
        assert_eq!(parse_hello(&[]), None);
        assert_eq!(parse_hello(&[K_HELLO, 0, 0, 0, 0]), None);
        // 日本語名相当の非ASCIIも通る
        let b2 = hello_bin("t_x", "あ");
        assert_eq!(parse_hello(&b2), Some(("t_x".into(), "あ".into())));
    }

    #[test]
    fn watch_roundtrip() {
        let tiles = vec![(1, -2), (0, 0), (19999, -19999)];
        let b = watch_bin(&tiles);
        assert_eq!(parse_watch(&b), Some(tiles));
        assert_eq!(parse_watch(&[]), None);
        // 上限超過は拒否
        let mut v = vec![K_WATCH];
        v.extend_from_slice(&((WATCH_TILE_CAP + 1) as u16).to_le_bytes());
        for _ in 0..WATCH_TILE_CAP + 1 {
            v.extend_from_slice(&0i32.to_le_bytes());
            v.extend_from_slice(&0i32.to_le_bytes());
        }
        assert_eq!(parse_watch(&v), None);
    }

    #[test]
    fn hello_ok_roundtrip() {
        let b = hello_ok_bin(true, HELLO_ERR_NONE, "abcdef");
        assert_eq!(parse_hello_ok(&b), Some((true, 0, "abcdef".into())));
        let b2 = hello_ok_bin(false, HELLO_ERR_TURNSTILE, "");
        assert_eq!(parse_hello_ok(&b2), Some((false, 2, "".into())));
    }

    #[test]
    fn join_roundtrip() {
        let b = join_bin("abcdef", "ななし", 0x22, 0xaa, 0x66, 12);
        assert_eq!(
            parse_join(&b),
            Some(("abcdef".into(), "ななし".into(), (0x22, 0xaa, 0x66), 12))
        );
        assert_eq!(parse_join(&[]), None);
    }
}
