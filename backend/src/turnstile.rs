//! Turnstile検証 (ページ表示の度に必須)。
//! `hello{ticket, turnstileToken}` のturnstileTokenをsiteverifyする。

use std::time::Duration;

pub async fn verify(
    secret: &str,
    token: &str,
    ip: &str,
    timeout_sec: u64,
) -> bool {
    if secret.is_empty() || token.is_empty() {
        return false;
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_sec))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let resp = client
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
