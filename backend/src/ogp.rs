//! OGP画像の軽量レンダ (依存クレートなし・手詰めPNG)。
//! 原点中心1200x630・1px1セル。グリッド＋原点軸＋実ピクセル。
//! PNGはstored-deflateのみで符号化する (圧縮率は落ちるが依存ゼロ)。

pub const OGP_W: i32 = 1200;
pub const OGP_H: i32 = 630;
/// 1回の読取上限行数 (原点周辺ウィンドウ用)
const PIXEL_CAP: i64 = 60000;

fn hex_to_rgb(s: &str) -> (u8, u8, u8) {
    crate::color::hex_to_rgb(s)
}

fn shade(c: (u8, u8, u8), f: f64) -> (u8, u8, u8) {
    let m = |v: u8| ((v as f64) * f).round().clamp(0.0, 255.0) as u8;
    (m(c.0), m(c.1), m(c.2))
}

pub(crate) fn blend(over: (u8, u8, u8), under: (u8, u8, u8), alpha: f64) -> (u8, u8, u8) {
    let m = |o: u8, u: u8| (o as f64 * alpha + u as f64 * (1.0 - alpha)).round() as u8;
    (m(over.0, under.0), m(over.1, under.1), m(over.2, under.2))
}

fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for (i, slot) in t.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    t
}

fn crc32(data: &[u8]) -> u32 {
    let t = crc_table();
    let mut c = 0xFFFFFFFFu32;
    for b in data {
        c = t[((c ^ (*b as u32)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFFFFFF
}

fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for chunk in data.chunks(5552) {
        for byte in chunk {
            a = (a + *byte as u32) % 65521;
            b = (b + a) % 65521;
        }
    }
    (b << 16) | a
}

/// zlibラッパ＋stored-deflateのみ (圧縮なし)。 decoder不要の最小構成。
fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78u8, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, b) in blocks.iter().enumerate() {
        out.push(if i + 1 == blocks.len() { 0x01 } else { 0x00 });
        out.extend_from_slice(&(b.len() as u16).to_le_bytes());
        out.extend_from_slice(&(!(b.len() as u16)).to_le_bytes());
        out.extend_from_slice(b);
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(12 + data.len());
    v.extend_from_slice(&(data.len() as u32).to_be_bytes());
    v.extend_from_slice(tag);
    v.extend_from_slice(data);
    let mut c = Vec::with_capacity(4 + data.len());
    c.extend_from_slice(tag);
    c.extend_from_slice(data);
    v.extend_from_slice(&crc32(&c).to_be_bytes());
    v
}

pub(crate) fn encode_png(rgb: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut raw = Vec::with_capacity((h * (1 + w * 3)) as usize);
    for y in 0..h {
        raw.push(0); // filter: None
        let o = (y * w * 3) as usize;
        raw.extend_from_slice(&rgb[o..o + (w * 3) as usize]);
    }
    let mut png = vec![137u8, 80, 78, 71, 13, 10, 26, 10];
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8bit truecolor
    png.extend(chunk(b"IHDR", &ihdr));
    png.extend(chunk(b"IDAT", &zlib_stored(&raw)));
    png.extend(chunk(b"IEND", &[]));
    png
}

/// 原点中心ウィンドウを描く。DB失敗時は背景単色＋グリッドのみ返す (空bodyにしない)
pub async fn render(pool: &sqlx::PgPool, background: &str) -> Vec<u8> {
    let w = OGP_W;
    let h = OGP_H;
    let bg = hex_to_rgb(background);
    let grid = shade(bg, 0.92);
    let axis = shade(bg, 0.7);
    let mut px = vec![0u8; (w * h * 3) as usize];
    for c in px.chunks_exact_mut(3) {
        c.copy_from_slice(&[bg.0, bg.1, bg.2]);
    }
    let mut set = |x: i32, y: i32, c: (u8, u8, u8)| {
        if x < 0 || y < 0 || x >= w || y >= h {
            return;
        }
        let o = ((y * w + x) * 3) as usize;
        px[o..o + 3].copy_from_slice(&[c.0, c.1, c.2]);
    };
    for x in (0..w).step_by(32) {
        for y in 0..h {
            set(x, y, grid);
        }
    }
    for y in (0..h).step_by(32) {
        for x in 0..w {
            set(x, y, grid);
        }
    }
    // 原点軸
    for x in 0..w {
        set(x, h / 2, axis);
    }
    for y in 0..h {
        set(w / 2, y, axis);
    }
    let now = chrono::Utc::now().timestamp() as f64;
    let rows = sqlx::query(
        "SELECT x, y, c, t FROM pixels
          WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
          AND (chalkUntil = 0 OR chalkUntil > $5) LIMIT $6",
    )
    .bind(-w / 2)
    .bind(w / 2 - 1)
    .bind(-h / 2)
    .bind(h / 2 - 1)
    .bind(now)
    .bind(PIXEL_CAP)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for r in &rows {
        use sqlx::Row;
        let x: i32 = r.get(0);
        let y: i32 = r.get(1);
        let mut c = crate::color::int_to_rgb(r.get::<i32, _>(2));
        // ghostは下地と混色 (特殊インクの見た目を保つ)
        if r.get::<i16, _>(3) & 2 != 0 {
            c = blend(c, bg, 0.5);
        }
        set(x + w / 2, y + h / 2, c);
    }
    encode_png(&px, w as u32, h as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vectors() {
        assert_eq!(crc32(b"123456789"), 0xCBF43926);
        assert_eq!(adler32(b"123456789"), 0x091E01DE);
    }

    #[test]
    fn png_shape() {
        let rgb = vec![255u8; 6 * 2 * 3];
        let png = encode_png(&rgb, 6, 2);
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert!(png.ends_with(&[0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
        // IHDRのCRCが自前crcと一致 (構造検査)
        let ihdr_len =
            u32::from_be_bytes([png[8], png[9], png[10], png[11]]) as usize;
        assert_eq!(ihdr_len, 13);
        let got = u32::from_be_bytes([
            png[8 + 8 + ihdr_len],
            png[8 + 8 + ihdr_len + 1],
            png[8 + 8 + ihdr_len + 2],
            png[8 + 8 + ihdr_len + 3],
        ]);
        assert_eq!(got, crc32(&png[12..12 + 4 + ihdr_len]));
    }
}
