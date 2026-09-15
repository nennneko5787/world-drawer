//! WSハブ (素のWebSocket。Socket.IO廃止)。
//! interest管理: 接続ごとの購読タイルにだけ配信する (全員broadcast廃止)。
//! ペイロードはバイナリ (ws_proto)。join/helloOk等の稀な制御系のみJSONテキスト。

use dashmap::DashMap;
use std::collections::HashSet;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub enum WsOut {
    Text(String),
    Bin(Vec<u8>),
}

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
}

impl Hub {
    pub fn new() -> Self {
        Self {
            sinks: Arc::new(DashMap::new()),
            watch: Arc::new(DashMap::new()),
            infos: Arc::new(DashMap::new()),
            tickets: Arc::new(DashMap::new()),
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

    pub fn remove(&self, sid: &str) -> Option<PeerInfo> {
        self.sinks.remove(sid);
        self.watch.remove(sid);
        self.infos.remove(sid).map(|(_, info)| info)
    }
}
