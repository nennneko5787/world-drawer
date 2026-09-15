//! ルーター集約。APIはEdgeキャッシュBYPASS前提 (Cache-Control: no-store)。

use axum::Router;
use sqlx::PgPool;

use crate::config::Config;
use crate::ws::Hub;

pub mod admin;
pub mod canvas;
pub mod history;
pub mod me;
pub mod place;
pub mod profile;
pub mod account;
pub mod session;
pub mod ticket;
pub mod undo;
pub mod users;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub pool: PgPool,
    pub redis: redis::aio::ConnectionManager,
    pub hub: Hub,
}

impl AppState {
    pub fn new(cfg: Config, pool: PgPool, redis: redis::aio::ConnectionManager) -> Self {
        Self {
            cfg,
            pool,
            redis,
            hub: Hub::new(),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/canvas", axum::routing::get(canvas::bbox))
        .route("/api/bounds", axum::routing::get(canvas::bounds))
        .route("/api/me", axum::routing::get(me::me))
        .route("/api/session", axum::routing::post(session::create))
        .route("/api/ws-ticket", axum::routing::post(ticket::create))
        .route("/api/place", axum::routing::post(place::place))
        .route("/api/undo", axum::routing::post(undo::undo))
        .route("/api/history", axum::routing::get(history::history))
        .route("/api/profile", axum::routing::post(profile::update))
        .route("/api/account/issue", axum::routing::post(account::issue))
        .route("/api/account/login", axum::routing::post(account::login))
        .route("/api/admin/status", axum::routing::post(admin::status))
        .route("/api/admin/lookup", axum::routing::post(admin::lookup))
        .route("/api/admin/rollback", axum::routing::post(admin::rollback))
        .route("/api/admin/ban", axum::routing::post(admin::ban))
        .route("/api/users", axum::routing::get(users::list))
        .route("/ws", axum::routing::get(crate::routes::ws_route::handle))
        .route("/og-image.png", axum::routing::get(canvas::og_image))
        .route("/healthz", axum::routing::get(|| async { "ok" }))
        .with_state(state)
}

pub mod ws_route {
    use crate::ip;
    use crate::rate;
    use crate::routes::AppState;
    use crate::turnstile;
    use axum::extract::ConnectInfo;
    use axum::extract::State;
    use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
    use axum::http::HeaderMap;
    use axum::response::Response;
    use futures_util::{SinkExt, StreamExt};
    use std::net::SocketAddr;
    use std::time::Duration;

    pub async fn handle(
        ws: WebSocketUpgrade,
        ConnectInfo(peer): ConnectInfo<SocketAddr>,
        headers: HeaderMap,
        State(state): State<AppState>,
    ) -> Response {
        let peer_s = peer.ip().to_string();
        let cf = headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let xff = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        ws.on_upgrade(move |socket| async move {
            serve(socket, state, peer_s, cf, xff).await;
        })
    }

    async fn serve(
        socket: WebSocket,
        mut state: AppState,
        peer_s: String,
        cf: String,
        xff: String,
    ) {
        let nets = ip::parse_nets(&state.cfg.trusted_proxies);
        let client_ip = ip::resolve_client_ip(&peer_s, &cf, &xff, &nets);
        // hello前レート制限 (偽token連打→siteverify増幅対策)
        if !rate::allow(&mut state.redis, "hello", &client_ip, 5, 60.0).await {
            return;
        }
        let (mut sink, mut stream) = socket.split();
        // 初手helloを10秒待つ
        let first = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
        let Ok(Some(Ok(Message::Text(text)))) = first else {
            return;
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        if v.get("t").and_then(|x| x.as_str()) != Some("hello") {
            return;
        }
        let ticket = v.get("ticket").and_then(|x| x.as_str()).unwrap_or("");
        let ts_token = v
            .get("turnstileToken")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let Some(token) = state.hub.tickets.remove(ticket).and_then(|(_, (tok, exp))| {
            if chrono::Utc::now().timestamp() <= exp {
                Some(tok)
            } else {
                None
            }
        }) else {
            let _ = sink
                .send(Message::Text(
                    r#"{"t":"helloOk","ok":false,"error":"badTicket"}"#.into(),
                ))
                .await;
            return;
        };
        // Turnstile必須 (ページ表示の度)
        let enforce = state
            .cfg
            .turnstile
            .as_ref()
            .map(|t| t.enforce)
            .unwrap_or(true);
        if enforce {
            let (secret, timeout) = state
                .cfg
                .turnstile
                .as_ref()
                .map(|t| (t.secret_key.clone(), t.timeout_sec))
                .unwrap_or_default();
            if !turnstile::verify(&secret, ts_token, &client_ip, timeout).await {
                let _ = sink
                    .send(Message::Text(
                        r#"{"t":"helloOk","ok":false,"error":"turnstileRequired"}"#.into(),
                    ))
                    .await;
                return;
            }
        }
        // ユーザー解決
        let row = sqlx::query(
            "SELECT uid, name, color, level FROM users WHERE token = $1",
        )
        .bind(&token)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
        let Some(r) = row else {
            let _ = sink
                .send(Message::Text(
                    r#"{"t":"helloOk","ok":false,"error":"noUser"}"#.into(),
                ))
                .await;
            return;
        };
        use sqlx::Row;
        let uid: String = r.get(0);
        let name: String = r.get(1);
        let color: String = r.get(2);
        let level: i64 = r.get(3);

        let sid = uuid::Uuid::new_v4().simple().to_string();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
        state.hub.peers.insert(uid.clone(), tx.clone());
        state.hub.conns.insert(sid.clone(), uid.clone());
        // presence joinをbroadcast
        let _ = state.hub.pixel_tx.send(
            serde_json::json!({"t":"join","uid":uid.clone(),"name":name.clone(),"color":color.clone(),"level":level})
                .to_string(),
        );
        let ok = serde_json::json!({"t":"helloOk","ok":true,"uid":uid.clone()}).to_string();
        if sink.send(Message::Text(ok.into())).await.is_err() {
            state.hub.peers.remove(&uid);
            state.hub.conns.remove(&sid);
            return;
        }
        let mut sub = state.hub.pixel_tx.subscribe();
        let ping_interval = Duration::from_secs(20);
        let mut ping = tokio::time::interval(ping_interval);
        // 送信タスク
        let send_fut = async move {
            loop {
                tokio::select! {
                    _ = ping.tick() => {
                        if sink.send(Message::Ping(vec![].into())).await.is_err() { break; }
                    }
                    msg = rx.recv() => {
                        let Some(m) = msg else { break };
                        if sink.send(Message::Text(m.into())).await.is_err() { break; }
                    }
                    msg = sub.recv() => {
                        // lag時は捨てる (全体を道連れにしない)
                        if let Ok(m) = msg {
                            // 自分のcursorは送り返さない簡易判定: 送信側でuid一致は弾く前提
                            if sink.send(Message::Text(m.into())).await.is_err() { break; }
                        }
                    }
                }
            }
        };
        // 受信 (cursorのみ中継、200ms間引きはクライアント+サーバ両方)
        let hub2 = state.hub.clone();
        let (uid_r, name_r, color_r) = (uid.clone(), name.clone(), color.clone());
        let mut last_bc = std::time::Instant::now()
            .checked_sub(Duration::from_millis(300))
            .unwrap();
        let mut last_cell = String::new();
        let recv_fut = async move {
            while let Some(Ok(msg)) = stream.next().await {
                match msg {
                    Message::Text(t) => {
                        let v: serde_json::Value =
                            serde_json::from_str(&t).unwrap_or_default();
                        if v.get("t").and_then(|x| x.as_str()) == Some("cursor") {
                            let x = v.get("x").and_then(|n| n.as_i64()).unwrap_or(0) as i32;
                            let y = v.get("y").and_then(|n| n.as_i64()).unwrap_or(0) as i32;
                            if x.abs() > 1_000_000 || y.abs() > 1_000_000 {
                                continue;
                            }
                            let key = format!("{x},{y}");
                            let now = std::time::Instant::now();
                            if key == last_cell
                                || now.duration_since(last_bc)
                                    < Duration::from_millis(200)
                            {
                                continue;
                            }
                            last_bc = now;
                            last_cell = key;
                            let _ = hub2.pixel_tx.send(
                                serde_json::json!({
                                    "t":"cursor","uid":uid_r,"name":name_r,
                                    "color":color_r,"level":level,"x":x,"y":y
                                })
                                .to_string(),
                            );
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        };
        tokio::select! {
            _ = send_fut => {}
            _ = recv_fut => {}
        }
        state.hub.peers.remove(&uid);
        state.hub.conns.remove(&sid);
        let _ = state.hub.pixel_tx.send(
            serde_json::json!({"t":"leave","uid":uid.clone()}).to_string(),
        );
    }
}
