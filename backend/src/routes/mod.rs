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

    fn hello_ok(ok: bool, err: u8, uid: &str) -> Message {
        Message::Binary(ws_proto::hello_ok_bin(ok, err, uid).into())
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
        // 初手hello (Binary) を10秒待つ。Textは使わない
        let first = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
        let Ok(Some(Ok(Message::Binary(b)))) = first else {
            return;
        };
        let Some((ticket, ts_token)) = ws_proto::parse_hello(&b) else {
            return;
        };
        let Some(token) = state.hub.take_ticket(&ticket) else {
            let _ = sink
                .send(hello_ok(false, ws_proto::HELLO_ERR_BAD_TICKET, ""))
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
            let secret = state
                .cfg
                .turnstile
                .as_ref()
                .map(|t| t.secret_key.clone())
                .unwrap_or_default();
            if !turnstile::verify(&secret, &ts_token, &client_ip, 10).await {
                let _ = sink
                    .send(hello_ok(false, ws_proto::HELLO_ERR_TURNSTILE, ""))
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
                .send(hello_ok(false, ws_proto::HELLO_ERR_NO_USER, ""))
                .await;
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
        {
            let (jr, jg, jb) = crate::color::hex_to_rgb(&info.color);
            state.hub.broadcast_all(
                &ws_proto::join_bin(&info.uid, &info.name, jr, jg, jb, info.level),
                Some(&sid),
            );
        }
        if sink
            .send(hello_ok(true, ws_proto::HELLO_ERR_NONE, &info.uid))
            .await
            .is_err()
        {
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
                        if sink.send(Message::Binary(m.into())).await.is_err() { break; }
                    }
                }
            }
        };
        // 受信: 完全バイナリ。Textフレームは使わない (旧クライアントはhello応答が無く polling に落ちる)
        let hub2 = state.hub.clone();
        let sid2 = sid.clone();
        let recv_fut = async move {
            let mut last_bc = std::time::Instant::now()
                .checked_sub(Duration::from_millis(300))
                .unwrap();
            let mut last_cell = String::new();
            while let Some(Ok(msg)) = stream.next().await {
                let Message::Binary(b) = msg else {
                    continue;
                };
                match b.first().copied() {
                    Some(2) if b.len() >= 15 => {
                        // cursor (購読タイル宛にバイナリ中継)
                        let x = i32::from_le_bytes([b[1], b[2], b[3], b[4]]);
                        let y = i32::from_le_bytes([b[5], b[6], b[7], b[8]]);
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
                            &ws_proto::cursor_bin(x, y, &uid),
                            Some(&sid2),
                        );
                    }
                    Some(5) => {
                        // watch (購読更新)
                        let Some(tiles) = ws_proto::parse_watch(&b) else {
                            continue;
                        };
                        let set: HashSet<(i32, i32)> = tiles.into_iter().collect();
                        hub2.watch.insert(sid2.clone(), set.clone());
                        // 新規購読タイルの既存者をスナップショット送信
                        for (_, info) in hub2.joins_for(&sid2, &set) {
                            let (jr, jg, jb) = crate::color::hex_to_rgb(&info.color);
                            let _ = hub2.sinks.get(&sid2).map(|s| {
                                s.value().1.try_send(ws_proto::join_bin(
                                    &info.uid, &info.name, jr, jg, jb, info.level,
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
            state
                .hub
                .broadcast_all(&ws_proto::leave_bin(&info.uid), Some(&sid));
        }
    }
}
