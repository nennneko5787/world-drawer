//! Turnstile検証 (ページ表示の度に必須)。
//! `hello{ticket, turnstileToken}` のturnstileTokenをsiteverifyする。

use std::time::Duration;

// 使い回し単一クライアント (毎回buildするとTLSハンドシェイクからやり直しになる)
fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("turnstile client")
    })
}

pub async fn verify(secret: &str, token: &str, ip: &str, _timeout_sec: u64) -> bool {
    if secret.is_empty() || token.is_empty() {
        return false;
    }
    let resp = client()
        .post("https://challenges.cloudflare.com/turnstile/v0/siteverify")
        .form(&[("secret", secret), ("response", token), ("remoteip", ip)])
        .send()
        .await;
    let Ok(r) = resp else { return false };
    let Ok(v) = r.json::<serde_json::Value>().await else {
        return false;
    };
    v.get("success").and_then(|s| s.as_bool()).unwrap_or(false)
}
