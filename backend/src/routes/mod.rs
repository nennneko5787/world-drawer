//! ルーター集約。APIはEdgeキャッシュBYPASS前提 (Cache-Control: no-store)。

use axum::Router;
use sqlx::PgPool;

use crate::config::Config;
use crate::tiles::TileVersions;
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
pub mod tiles;
pub mod undo;
pub mod users;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub pool: PgPool,
    pub redis: redis::aio::ConnectionManager,
    pub hub: Hub,
    pub tiles: TileVersions,
}

impl AppState {
    pub fn new(cfg: Config, pool: PgPool, redis: redis::aio::ConnectionManager) -> Self {
        Self {
            cfg,
            pool,
            redis,
            hub: Hub::new(),
            tiles: TileVersions::default(),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/canvas", axum::routing::get(canvas::bbox))
        .route("/api/tiles", axum::routing::get(tiles::tiles))
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
    use crate::tiles::tile_of;
    use crate::turnstile;
    use crate::ws::{PeerInfo, WsOut};
    use crate::ws_proto;
    use axum::extract::ConnectInfo;
    use axum::extract::State;
    use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
    use axum::http::HeaderMap;
    use axum::response::Response;
    use futures_util::{SinkExt, StreamExt};
    use std::collections::HashSet;
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

    fn hello_err(s: &str) -> Message {
        Message::Text(format!(r#"{{"t":"helloOk","ok":false,"error":"{s}"}}"#).into())
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
        let Some(token) = state.hub.take_ticket(ticket) else {
            let _ = sink.send(hello_err("badTicket")).await;
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
            let secret = state
                .cfg
                .turnstile
                .as_ref()
                .map(|t| t.secret_key.clone())
                .unwrap_or_default();
            if !turnstile::verify(&secret, ts_token, &client_ip, 10).await {
                let _ = sink.send(hello_err("turnstileRequired")).await;
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
            let _ = sink.send(hello_err("noUser")).await;
            return;
        };
        use sqlx::Row;
        let info = PeerInfo {
            uid: r.get::<String, _>(0),
            name: r.get::<String, _>(1),
            color: crate::color::int_to_hex(r.get::<i32, _>(2)),
            level: r.get::<i32, _>(3) as i64,
        };

        let sid = uuid::Uuid::new_v4().simple().to_string();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<WsOut>(64);
        state.hub.sinks.insert(sid.clone(), (info.uid.clone(), tx));
        state.hub.infos.insert(sid.clone(), info.clone());
        // presence joinを全体へ (稀なのでbroadcast可)
        state.hub.broadcast_all(
            &WsOut::Text(
                serde_json::json!({"t":"join","uid":info.uid,"name":info.name,
                    "color":info.color,"level":info.level})
                .to_string(),
            ),
            Some(&sid),
        );
        let ok = serde_json::json!({"t":"helloOk","ok":true,"uid":info.uid}).to_string();
        if sink.send(Message::Text(ok.into())).await.is_err() {
            state.hub.remove(&sid);
            return;
        }
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
                        let out = match m {
                            WsOut::Text(t) => Message::Text(t.into()),
                            WsOut::Bin(b) => Message::Binary(b.into()),
                        };
                        if sink.send(out).await.is_err() { break; }
                    }
                }
            }
        };
        // 受信: cursorは購読タイル宛にバイナリ中継、watchで購読更新
        let hub2 = state.hub.clone();
        let sid2 = sid.clone();
        let recv_fut = async move {
            let mut last_bc = std::time::Instant::now()
                .checked_sub(Duration::from_millis(300))
                .unwrap();
            let mut last_cell = String::new();
            while let Some(Ok(msg)) = stream.next().await {
                let Message::Text(t) = msg else {
                    continue;
                };
                let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                match v.get("t").and_then(|x| x.as_str()) {
                    Some("cursor") => {
                        let x = v.get("x").and_then(|n| n.as_i64()).unwrap_or(0) as i32;
                        let y = v.get("y").and_then(|n| n.as_i64()).unwrap_or(0) as i32;
                        if x.abs() > 1_000_000 || y.abs() > 1_000_000 {
                            continue;
                        }
                        let key = format!("{x},{y}");
                        let now = std::time::Instant::now();
                        if key == last_cell
                            || now.duration_since(last_bc) < Duration::from_millis(200)
                        {
                            continue;
                        }
                        last_bc = now;
                        last_cell = key;
                        let uid = hub2
                            .infos
                            .get(&sid2)
                            .map(|i| i.uid.clone())
                            .unwrap_or_default();
                        hub2.send_to_watchers(
                            tile_of(x, y),
                            &WsOut::Bin(ws_proto::cursor_bin(x, y, &uid)),
                            Some(&sid2),
                        );
                    }
                    Some("watch") => {
                        let mut set = HashSet::new();
                        if let Some(arr) = v.get("tiles").and_then(|a| a.as_array()) {
                            for item in arr.iter().take(512) {
                                let Some(s) = item.as_str() else { continue };
                                let mut it = s.split(',');
                                let (Some(a), Some(b)) = (it.next(), it.next()) else {
                                    continue;
                                };
                                if it.next().is_some() {
                                    continue;
                                }
                                if let (Ok(tx), Ok(ty)) =
                                    (a.parse::<i32>(), b.parse::<i32>())
                                {
                                    if tx.abs() <= 20000 && ty.abs() <= 20000 {
                                        set.insert((tx, ty));
                                    }
                                }
                            }
                        }
                        hub2.watch.insert(sid2.clone(), set.clone());
                        // 新規購読タイルの既存者をスナップショット送信
                        for (_, info) in hub2.joins_for(&sid2, &set) {
                            let _ = hub2.sinks.get(&sid2).map(|s| {
                                s.value().1.try_send(WsOut::Text(
                                    serde_json::json!({"t":"join","uid":info.uid,
                                        "name":info.name,"color":info.color,
                                        "level":info.level})
                                    .to_string(),
                                ))
                            });
                        }
                    }
                    _ => {}
                }
            }
        };
        tokio::select! {
            _ = send_fut => {}
            _ = recv_fut => {}
        }
        if let Some(info) = state.hub.remove(&sid) {
            state.hub.broadcast_all(
                &WsOut::Bin(ws_proto::leave_bin(&info.uid)),
                Some(&sid),
            );
        }
    }
}
