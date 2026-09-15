//! タイル差分同期用バージョン管理。
//! 全量ポーリング (bbox毎回MB級) の代替。64x64セル単位で版を持ち、
//! 書込時にだけ版を上げる。読取は変わったタイルだけ返す。

use dashmap::DashMap;
use std::sync::Arc;

pub const TILE: i32 = 128;
/// 1回の /api/tiles で要求できるタイル数上限 (ズームアウトしすぎは拒否)
pub const MAX_TILES_PER_REQ: usize = 256;

pub fn tile_of(x: i32, y: i32) -> (i32, i32) {
    (x.div_euclid(TILE), y.div_euclid(TILE))
}

#[derive(Clone, Default)]
pub struct TileVersions {
    inner: Arc<DashMap<(i32, i32), u64>>,
}

impl TileVersions {
    pub fn bump(&self, x: i32, y: i32) {
        let k = tile_of(x, y);
        self.inner
            .entry(k)
            .and_modify(|v| *v = v.wrapping_add(1))
            .or_insert(1);
    }

    pub fn get(&self, tx: i32, ty: i32) -> u64 {
        self.inner.get(&(tx, ty)).map(|v| *v).unwrap_or(0)
    }
}
