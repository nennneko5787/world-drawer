//! クライアントIP解決 (Python resolveClientIp の移植)。
//! trustedProxies経由のみヘッダを信用し、直結はpeerを使う。

use ipnet::IpNet;
use std::net::IpAddr;
use std::str::FromStr;

pub fn parse_nets(raw: &[String]) -> Vec<IpNet> {
    raw.iter()
        .filter_map(|s| IpNet::from_str(s.trim()).ok())
        .collect()
}

pub fn peer_trusted(peer: &str, nets: &[IpNet]) -> bool {
    let Ok(addr) = IpAddr::from_str(peer.trim()) else {
        return false;
    };
    nets.iter().any(|n| n.contains(&addr))
}

fn single_ip(s: &str) -> Option<String> {
    let c = s.trim();
    if c.is_empty() || c.contains(',') {
        return None;
    }
    IpAddr::from_str(c).ok().map(|a| a.to_string())
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
    if peer.is_empty() {
        "unknown".to_string()
    } else {
        peer.to_string()
    }
}
