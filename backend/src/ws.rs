//! WSハブ (素のWebSocket。Socket.IO廃止)。
//! interest管理: 接続ごとの購読タイルにだけ配信する (全員broadcast廃止)。
//! 完全バイナリ (ws_proto)。Textフレームは使わない。

use dashmap::DashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

/// WS送信ペイロード。完全バイナリ (Textフレームは使わない)
pub type WsOut = Vec<u8>;

#[derive(Clone, Debug)]
pub struct PeerInfo {
    pub uid: String,
    pub name: String,
    pub color: String,
    pub level: i64,
}

#[derive(Clone)]
pub struct Hub {
    /// sid -> (uid, 送信チャネル)
    pub sinks: Arc<DashMap<String, (String, tokio::sync::mpsc::Sender<WsOut>)>>,
    /// sid -> 購読タイル
    pub watch: Arc<DashMap<String, HashSet<(i32, i32)>>>,
    /// sid -> 表示情報 (joinスナップショット用)
    pub infos: Arc<DashMap<String, PeerInfo>>,
    /// ワンタイムチケット: ticket -> (token, expires_unix)
    pub tickets: Arc<DashMap<String, (String, i64)>>,
    /// sid -> 接続元IP (maxSocketsPerIp用)
    pub sid_ip: Arc<DashMap<String, String>>,
    /// sid -> 紐付きtoken (切断時の掃除用)
    pub sid_token: Arc<DashMap<String, String>>,
    /// token -> 生存sid集合 (noSocket判定用。切断で抜けるため在席=生存)
    pub token_sids: Arc<DashMap<String, HashSet<String>>>,
    /// sid -> (x, y, 受信時刻) (cursorMismatch判定用)
    pub cursors: Arc<DashMap<String, (i32, i32, Instant)>>,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            sinks: Arc::new(DashMap::new()),
            watch: Arc::new(DashMap::new()),
            infos: Arc::new(DashMap::new()),
            tickets: Arc::new(DashMap::new()),
            sid_ip: Arc::new(DashMap::new()),
            sid_token: Arc::new(DashMap::new()),
            token_sids: Arc::new(DashMap::new()),
            cursors: Arc::new(DashMap::new()),
        }
    }

    /// チケット消費 (使い切り・期限切れはNone)。成功時は長期tokenを返す。
    pub fn take_ticket(&self, ticket: &str) -> Option<String> {
        let (_, (token, exp)) = self.tickets.remove(ticket)?;
        if chrono::Utc::now().timestamp() > exp {
            return None;
        }
        Some(token)
    }

    /// 失効チケット掃除 (未使用のまま残った分。60秒毎に呼ぶ)
    pub fn gc_tickets(&self) {
        let now = chrono::Utc::now().timestamp();
        self.tickets.retain(|_, (_, exp)| *exp > now);
    }

    pub fn live_count(&self) -> usize {
        self.sinks.len()
    }

    fn send_to(&self, sid: &str, msg: &WsOut) {
        if let Some(s) = self.sinks.get(sid) {
            let _ = s.value().1.try_send(msg.clone());
        }
    }

    /// 購読タイルにだけ配信 (backpressure時は落とす。全体を道連れにしない)
    pub fn send_to_watchers(&self, tile: (i32, i32), msg: &WsOut, exclude: Option<&str>) {
        for w in self.watch.iter() {
            let sid = w.key();
            if exclude == Some(sid.as_str()) {
                continue;
            }
            if w.value().contains(&tile) {
                self.send_to(sid, msg);
            }
        }
    }

    /// 全接続へ (join/leave等の稀な制御系のみ)
    pub fn broadcast_all(&self, msg: &WsOut, exclude: Option<&str>) {
        for s in self.sinks.iter() {
            if exclude == Some(s.key().as_str()) {
                continue;
            }
            let _ = s.value().1.try_send(msg.clone());
        }
    }

    /// 新規購読者が見るべき既存者のjoin一覧 (タイル重複分)
    pub fn joins_for(&self, sid: &str, tiles: &HashSet<(i32, i32)>) -> Vec<(String, PeerInfo)> {
        let mut out = vec![];
        let mut seen = HashSet::new();
        for w in self.watch.iter() {
            if w.key() == sid || !w.value().iter().any(|t| tiles.contains(t)) {
                continue;
            }
            if let Some(info) = self.infos.get(w.key()) {
                if seen.insert(info.uid.clone()) {
                    out.push((w.key().clone(), info.clone()));
                }
            }
        }
        out
    }

    /// hello成功時の紐付け (sid→token→ip)。noSocket・maxSockets・cursor判定の土台。
    pub fn bind(&self, sid: &str, token: &str, ip: &str) {
        self.sid_ip.insert(sid.to_string(), ip.to_string());
        self.sid_token.insert(sid.to_string(), token.to_string());
        self.token_sids
            .entry(token.to_string())
            .or_default()
            .insert(sid.to_string());
    }

    /// tokenに生存接続があるか (noSocket判定)。在席=生存のため存在検査のみ。
    pub fn token_has_live(&self, token: &str) -> bool {
        self.token_sids
            .get(token)
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }

    /// 同一IPの生存接続数 (maxSocketsPerIp用)。IP不明時は呼ばないこと。
    pub fn sockets_from_ip(&self, ip: &str) -> usize {
        self.sid_ip.iter().filter(|e| e.value() == ip).count()
    }

    /// カーソル記録 (中継の間引きとは無関係に毎回呼ぶ。Pythonのpresence記録相当)
    pub fn note_cursor(&self, sid: &str, x: i32, y: i32) {
        self.cursors
            .insert(sid.to_string(), (x, y, Instant::now()));
    }

    /// tokenのいずれかの接続が (x, y) 近傍に新鮮なカーソルを持つか
    pub fn cursor_matches(&self, token: &str, x: i32, y: i32) -> bool {
        use crate::place_logic::{CURSOR_FRESH_SEC, CURSOR_MAX_DIST};
        let Some(sids) = self.token_sids.get(token) else {
            return false;
        };
        for sid in sids.iter() {
            if let Some(c) = self.cursors.get(sid) {
                let (cx, cy, ts) = *c;
                if ts.elapsed().as_secs_f64() <= CURSOR_FRESH_SEC
                    && (cx - x).abs().max((cy - y).abs()) <= CURSOR_MAX_DIST
                {
                    return true;
                }
            }
        }
        false
    }

    /// tokenの紐付けを忘れる (引っ越し統合で旧行削除時。ソケット自体は切断時掃除)
    pub fn forget_token(&self, token: &str) {
        if let Some((_, sids)) = self.token_sids.remove(token) {
            for sid in sids {
                self.sid_token.remove(&sid);
                self.cursors.remove(&sid);
            }
        }
    }

    pub fn remove(&self, sid: &str) -> Option<PeerInfo> {
        self.sinks.remove(sid);
        self.watch.remove(sid);
        self.sid_ip.remove(sid);
        self.cursors.remove(sid);
        if let Some((_, token)) = self.sid_token.remove(sid) {
            if let Some(mut sids) = self.token_sids.get_mut(&token) {
                sids.remove(sid);
                if sids.is_empty() {
                    drop(sids);
                    self.token_sids.remove(&token);
                }
            }
        }
        self.infos.remove(sid).map(|(_, info)| info)
    }
}
