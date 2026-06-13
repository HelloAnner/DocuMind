use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use rust_embed::RustEmbed;

pub struct WebAsset {
    pub bytes: Cow<'static, [u8]>,
    pub content_type: String,
}

#[derive(RustEmbed)]
#[folder = "../../apps/web/out"]
struct EmbeddedWeb;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("DOCUMIND_WEB_DIR").or_else(|_| std::env::var("WEB_OUT_DIR")) {
        dirs.push(PathBuf::from(dir));
    }
    dirs.push(repo_root().join("apps/web/out"));
    dirs
}

pub fn get_asset(request_path: &str) -> Option<WebAsset> {
    let candidates = route_candidates(request_path);

    for candidate in &candidates {
        if let Some(asset) = EmbeddedWeb::get(candidate) {
            return Some(WebAsset {
                content_type: mime_guess::from_path(candidate)
                    .first_or_octet_stream()
                    .to_string(),
                bytes: asset.data,
            });
        }
    }

    for dir in candidate_dirs() {
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                if let Ok(bytes) = fs::read(&path) {
                    return Some(WebAsset {
                        content_type: mime_guess::from_path(&path)
                            .first_or_octet_stream()
                            .to_string(),
                        bytes: Cow::Owned(bytes),
                    });
                }
            }
        }
    }

    None
}

pub fn fallback_html() -> WebAsset {
    let html = r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DocuMind</title>
    <style>
      body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#1a1a1a; background:#faf9f7; }
      main { width:min(560px, calc(100vw - 48px)); border:1px solid rgba(0,0,0,.08); background:#fff; border-radius:12px; padding:28px; }
      h1 { margin:0 0 12px; font-size:20px; }
      p { margin:0 0 10px; line-height:1.6; color:#5a5a5a; }
      code { background:#f5f4f2; padding:2px 5px; border-radius:4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>DocuMind Rust runtime is running</h1>
      <p>Web assets have not been exported yet. Build the UI into <code>apps/web/out</code> or set <code>DOCUMIND_WEB_DIR</code>.</p>
    </main>
  </body>
</html>"#;
    WebAsset {
        bytes: Cow::Borrowed(html.as_bytes()),
        content_type: "text/html; charset=utf-8".to_string(),
    }
}

fn route_candidates(path: &str) -> Vec<String> {
    let normalized = normalize_path(path);
    let mut candidates = vec![normalized.clone()];

    if is_extensionless_route(&normalized) {
        candidates.push(format!("{normalized}.html"));
        candidates.push(format!("{normalized}/index.html"));
    }

    candidates
}

fn is_extensionless_route(path: &str) -> bool {
    !path.is_empty() && !path.rsplit('/').next().unwrap_or(path).contains('.')
}

fn normalize_path(path: &str) -> String {
    let decoded = percent_decode_str(path).decode_utf8_lossy();
    let clean = decoded.trim_start_matches('/');
    if clean.is_empty() || clean.contains("..") {
        "index.html".to_string()
    } else {
        clean.to_string()
    }
}
