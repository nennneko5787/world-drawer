//! 管理者用マップスナップショット (`GET /api/admin/map.png`)。
//! 描画済みピクセルのうち一番外側のものから原点中心の正方形PNGを作る
//! (1セル=1px。`max` 超過時のみ整数縮小)。
//! グリッド・軸・バッジは付けない素のマップ画像。
//! PNG符号化は `ogp::encode_png` (stored-deflate・依存ゼロ) を再利用する。

use crate::routes::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

/// 余白セル数 (既定)。0〜MAX_MARGINでクランプ。
const DEFAULT_MARGIN: i64 = 16;
const MAX_MARGIN: i64 = 512;
/// 出力一辺の上限px (既定)。0以下=上限なし (常に1セル=1px)。
const DEFAULT_MAX_SIDE: i64 = 4096;
/// ghostビット (ogp.rs・ws_proto.rsと同値)。
const GHOST_BIT: i16 = 2;

#[derive(Deserialize)]
pub struct MapQuery {
    pub margin: Option<i64>,
    pub max: Option<i64>,
}

/// 範囲→出力寸法。戻り値は (half, side, scale, out)。
/// half: 原点からの片側セル数 (余白込み)。side: 2*half+1。
/// cap: 出力一辺の上限px (None=上限なし)。
/// scale: 出力1pxあたりのセル数 (上限超え時のみ>1)。out: 出力一辺px。
fn geometry(extent: i64, margin: i64, cap: Option<i64>) -> (i64, i64, i64, i64) {
    let half = extent.max(0) + margin.clamp(0, MAX_MARGIN);
    let side = half * 2 + 1;
    let scale = match cap {
        None => 1,
        Some(c) => ((side + c - 1) / c.max(1)).max(1),
    };
    let out = (side + scale - 1) / scale;
    (half, side, scale, out)
}

fn busy() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        r#"{"ok":false,"error":"busy"}"#,
    )
        .into_response()
}

/// 原点中心の正方形スナップショット。管理者UID (Bearer) のみ。
pub async fn snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<MapQuery>,
) -> Response {
    if !crate::routes::admin::is_admin(&state, &headers).await {
        return (StatusCode::FORBIDDEN, r#"{"ok":false,"error":"forbidden"}"#)
            .into_response();
    }
    let margin = q.margin.unwrap_or(DEFAULT_MARGIN);
    // 上限px (既定4096)。0以下=上限なし。巨大マップで上限なしを指定すると
    // 出力バッファが青天井になるため、管理者自身の判断で使うこと。
    let cap: Option<i64> = match q.max.unwrap_or(DEFAULT_MAX_SIDE) {
        m if m <= 0 => None,
        m => Some(m),
    };
    let now = chrono::Utc::now().timestamp() as f64;
    // 一番外側 = MIN/MAXの絶対値最大。期限切れチョークは除外 (他APIと対)。
    // 集約クエリは行がなくても1行返すため、NULL=空マップとして余白だけ描く。
    let bounds = sqlx::query(
        "SELECT MIN(x), MIN(y), MAX(x), MAX(y) FROM pixels
          WHERE chalkUntil = 0 OR chalkUntil > $1",
    )
    .bind(now)
    .fetch_one(&state.pool)
    .await;
    let Ok(b) = bounds else { return busy() };
    use sqlx::Row;
    let extent: i64 = match (
        b.get::<Option<i32>, _>(0),
        b.get::<Option<i32>, _>(1),
        b.get::<Option<i32>, _>(2),
        b.get::<Option<i32>, _>(3),
    ) {
        (Some(x0), Some(y0), Some(x1), Some(y1)) => [
            (x0 as i64).abs(),
            (y0 as i64).abs(),
            (x1 as i64).abs(),
            (y1 as i64).abs(),
        ]
        .into_iter()
        .max()
        .unwrap_or(0),
        _ => 0,
    };
    let (half, _side, scale, out) = geometry(extent, margin, cap);
    // halfは座標上限+余白のためi32に収まる (2_000_000未満)。
    let h = half.min(i32::MAX as i64) as i32;
    let sc = scale.max(1) as i32;
    let w = out.max(1) as usize;
    let bg = crate::color::hex_to_rgb(&state.cfg.background);
    let mut px = vec![0u8; w * w * 3];
    for i in 0..w * w {
        let o = i * 3;
        px[o..o + 3].copy_from_slice(&[bg.0, bg.1, bg.2]);
    }
    // 行ストリームで塗る (全件collectしない。出力バッファは上限付きのため定数メモリ)。
    use futures_util::TryStreamExt;
    let mut rows = sqlx::query(
        "SELECT x, y, c, t FROM pixels
          WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4
          AND (chalkUntil = 0 OR chalkUntil > $5)",
    )
    .bind(-h)
    .bind(h)
    .bind(-h)
    .bind(h)
    .bind(now)
    .fetch(&state.pool);
    loop {
        match rows.try_next().await {
            Ok(Some(r)) => {
                let x: i32 = r.get(0);
                let y: i32 = r.get(1);
                let ox = (x + h) / sc;
                let oy = (y + h) / sc;
                if ox < 0 || oy < 0 || ox >= out as i32 || oy >= out as i32 {
                    continue;
                }
                let mut c = crate::color::int_to_rgb(r.get::<i32, _>(2));
                // ghostは下地と混色 (ogp.rsと同見た目)
                if r.get::<i16, _>(3) & GHOST_BIT != 0 {
                    c = crate::ogp::blend(c, bg, 0.5);
                }
                let o = (oy as usize * w + ox as usize) * 3;
                px[o..o + 3].copy_from_slice(&[c.0, c.1, c.2]);
            }
            Ok(None) => break,
            Err(_) => return busy(),
        }
    }
    let png = crate::ogp::encode_png(&px, out as u32, out as u32);
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    Response::builder()
        .header("content-type", "image/png")
        .header("cache-control", "no-store")
        .header(
            "content-disposition",
            format!("attachment; filename=\"pixdraw-map-{stamp}.png\""),
        )
        .header("x-map-width", out.to_string())
        .header("x-map-height", out.to_string())
        .header("x-map-scale", scale.to_string())
        .body(axum::body::Body::from(png))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_with_default_margin() {
        assert_eq!(geometry(0, 16, Some(4096)), (16, 33, 1, 33));
    }

    #[test]
    fn normal_extent() {
        assert_eq!(geometry(100, 16, Some(4096)), (116, 233, 1, 233));
    }

    #[test]
    fn margin_clamped() {
        assert_eq!(geometry(10, 9999, Some(4096)).0, 10 + MAX_MARGIN);
        assert_eq!(geometry(10, -5, Some(4096)).0, 10);
    }

    #[test]
    fn downscaled_when_over_cap() {
        // side=2*(3000+16)+1=6033 → scale=2, out=3017
        assert_eq!(geometry(3000, 16, Some(4096)), (3016, 6033, 2, 3017));
    }

    #[test]
    fn huge_always_bounded() {
        let (_half, side, scale, out) = geometry(1_000_000, 512, Some(4096));
        assert!(out <= 4096);
        assert!(out * scale >= side);
    }

    #[test]
    fn uncapped_when_zero() {
        // 上限なし (None) は常に等倍。巨大でも縮小しない
        assert_eq!(geometry(3000, 16, None), (3016, 6033, 1, 6033));
        assert_eq!(geometry(0, 16, None), (16, 33, 1, 33));
    }

    #[test]
    fn custom_cap() {
        // side=233 → cap=100 で scale=3, out=78
        assert_eq!(geometry(100, 16, Some(100)), (116, 233, 3, 78));
    }
}
