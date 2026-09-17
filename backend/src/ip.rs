//! クライアントIP解決。
//! trustedProxies経由のみヘッダを信用し、直結はpeerを使う。

use axum::http::HeaderMap;
use ipnet::{IpNet, Ipv4Net, Ipv6Net};
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

/// `trustedProxies` の1要素をパースする。
/// CIDR (`192.168.0.0/24`, `::1/128`) とベアIP (`127.0.0.1`, `::1`) の
/// 両方を受け付ける。ベアIPは /32・/128 の単一ホスト扱い。
/// ipnet 2.x の `IpNet::from_str` はCIDR必須のため、ベアIPはここで補う。
/// これが無いと既定の `["127.0.0.1", "::1"]` が全滅し、Tunnel経由でも
/// 全員 `127.0.0.1` になる。
fn parse_one(s: &str) -> Option<IpNet> {
    let t = s.trim().trim_matches('"').trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(n) = IpNet::from_str(t) {
        return Some(n);
    }
    if let Ok(addr) = IpAddr::from_str(t) {
        return match addr {
            IpAddr::V4(a) => Ipv4Net::new(a, 32).ok().map(IpNet::V4),
            IpAddr::V6(a) => Ipv6Net::new(a, 128).ok().map(IpNet::V6),
        };
    }
    None
}

pub fn parse_nets(raw: &[String]) -> Vec<IpNet> {
    raw.iter().filter_map(|s| parse_one(s)).collect()
}

/// peerが生のIPv4-mapped IPv6 (`::ffff:127.0.0.1`) で来ても
/// `127.0.0.1/32` の信頼設定にマッチさせる。
fn addr_variants(addr: &IpAddr) -> Vec<IpAddr> {
    let mut out = vec![*addr];
    if let IpAddr::V6(v6) = addr {
        if let Some(mapped) = v6.to_ipv4_mapped() {
            out.push(IpAddr::V4(mapped));
        }
    }
    out
}

pub fn peer_trusted(peer: &str, nets: &[IpNet]) -> bool {
    let Ok(addr) = IpAddr::from_str(peer.trim()) else {
        return false;
    };
    let variants = addr_variants(&addr);
    nets.iter().any(|n| variants.iter().any(|a| n.contains(a)))
}

fn single_ip(s: &str) -> Option<String> {
    let c = s.trim().trim_matches('"').trim();
    if c.is_empty() || c.contains(',') || c.eq_ignore_ascii_case("unknown") {
        return None;
    }
    // ブラケット付きIPv6 (`[::1]`) は剥がす。ポート付きは信用しない。
    let c = c.strip_prefix('[').and_then(|r| r.strip_suffix(']')).unwrap_or(c);
    IpAddr::from_str(c).ok().map(|a| a.to_string())
}

/// 信頼peer経由のときだけプロキシヘッダを信用する。
/// 優先度: `CF-Connecting-IP` → `True-Client-IP` → `X-Forwarded-For`先頭 →
/// `X-Real-IP`。直結の偽装ヘッダは無視しpeerを返す。
fn header_ip(headers: &HeaderMap) -> Option<String> {
    for key in ["cf-connecting-ip", "true-client-ip", "x-real-ip"] {
        if let Some(v) = headers.get(key).and_then(|v| v.to_str().ok()) {
            if let Some(ip) = single_ip(v) {
                return Some(ip);
            }
        }
    }
    if let Some(xff) = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        let first = xff.split(',').next().unwrap_or("");
        if let Some(ip) = single_ip(first) {
            return Some(ip);
        }
    }
    None
}

pub fn resolve_client_ip(
    peer: &str,
    cf_connecting_ip: &str,
    forwarded_for: &str,
    nets: &[IpNet],
) -> String {
    if peer_trusted(peer, nets) {
        if let Some(ip) = single_ip(cf_connecting_ip) {
            return ip;
        }
        if !forwarded_for.is_empty() {
            let first = forwarded_for.split(',').next().unwrap_or("");
            if let Some(ip) = single_ip(first) {
                return ip;
            }
        }
    }
    if peer.trim().is_empty() {
        "unknown".to_string()
    } else {
        peer.trim().to_string()
    }
}

/// 各ハンドラ共通のIP解決。`ConnectInfo` のpeerとリクエストヘッダから求める。
pub fn client_ip_from_headers(
    headers: &HeaderMap,
    peer: &SocketAddr,
    nets: &[IpNet],
) -> String {
    let peer_s = peer.ip().to_string();
    if peer_trusted(&peer_s, nets) {
        if let Some(ip) = header_ip(headers) {
            return ip;
        }
    }
    peer_s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nets(v: &[&str]) -> Vec<IpNet> {
        parse_nets(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn bare_loopback_is_trusted() {
        // 既定 ["127.0.0.1", "::1"] が空にならないこと (今回の本バグ)。
        let n = nets(&["127.0.0.1", "::1"]);
        assert_eq!(n.len(), 2, "bare IPs must parse as /32 and /128");
        assert!(peer_trusted("127.0.0.1", &n));
        assert!(peer_trusted("::1", &n));
        assert!(!peer_trusted("1.2.3.4", &n));
    }

    #[test]
    fn cidr_still_works() {
        let n = nets(&["10.0.0.0/8", "192.168.0.0/16", "127.0.0.1/32"]);
        assert_eq!(n.len(), 3);
        assert!(peer_trusted("10.1.2.3", &n));
        assert!(peer_trusted("192.168.1.5", &n));
        assert!(!peer_trusted("8.8.8.8", &n));
    }

    #[test]
    fn mapped_v4_loopback_is_trusted() {
        let n = nets(&["127.0.0.1"]);
        assert!(peer_trusted("::ffff:127.0.0.1", &n));
    }

    #[test]
    fn tunnel_headers_win_over_peer() {
        let n = nets(&["127.0.0.1", "::1"]);
        assert_eq!(
            resolve_client_ip("127.0.0.1", "203.0.113.7", "", &n),
            "203.0.113.7"
        );
        assert_eq!(
            resolve_client_ip("127.0.0.1", "", "198.51.100.9, 162.158.0.0", &n),
            "198.51.100.9"
        );
        // 直結はヘッダを無視する (偽装対策)。
        assert_eq!(
            resolve_client_ip("203.0.113.7", "1.1.1.1", "2.2.2.2", &n),
            "203.0.113.7"
        );
        // 信頼peerでもヘッダが無ければpeer。
        assert_eq!(resolve_client_ip("127.0.0.1", "", "", &n), "127.0.0.1");
    }

    #[test]
    fn invalid_entries_are_dropped() {
        let n = nets(&["", "  ", "not-an-ip", "127.0.0.1"]);
        assert_eq!(n.len(), 1);
    }
}
