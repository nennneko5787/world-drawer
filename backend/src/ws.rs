//! WSハブ (素のWebSocket。Socket.IO廃止)。
//! `POST /api/ws-ticket` → `hello{ticket, turnstileToken}` のみ接続。

use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct Hub {
    /// uid -> 送信チャネル
    pub peers: Arc<DashMap<String, tokio::sync::mpsc::Sender<String>>>,
    /// broadcast (pixel / cursor / presence / leave)
    pub pixel_tx: broadcast::Sender<String>,
    /// ワンタイムチケット: ticket -> (token, expires_unix)
    pub tickets: Arc<DashMap<String, (String, i64)>>,
    /// sid -> uid (切断時掃除用)
    pub conns: Arc<DashMap<String, String>>,
}

impl Hub {
    pub fn new() -> Self {
        let (pixel_tx, _) = broadcast::channel(1024);
        Self {
            peers: Arc::new(DashMap::new()),
            pixel_tx,
            tickets: Arc::new(DashMap::new()),
            conns: Arc::new(DashMap::new()),
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
}
