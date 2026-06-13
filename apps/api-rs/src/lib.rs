use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

pub async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "documind=info,tower_http=info".into()),
        )
        .init();

    let host = std::env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("SERVER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(5555);
    let addr: SocketAddr = format!("{host}:{port}").parse()?;

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(config_snapshot))
        .fallback(static_or_spa)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "DocuMind runtime listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "documind",
        "mode": "prototype"
    }))
}

async fn config_snapshot() -> impl IntoResponse {
    Json(json!({
        "tenant": "Acme Knowledge",
        "role": "tenant_admin",
        "auth": "disabled",
        "embedding": "bge-large-zh-v1.5",
        "retrieval": {
            "strategy": "hybrid",
            "topK": 8,
            "rerankTopK": 5,
            "threshold": 0.32
        }
    }))
}

async fn static_or_spa(req: Request<Body>) -> Response {
    let path = req.uri().path();
    if path.starts_with("/api/") {
        return (StatusCode::NOT_FOUND, Json(json!({"detail": "not found"}))).into_response();
    }
    if let Some(asset) = web_embed::get_asset(path) {
        return asset_response(asset);
    }
    if let Some(asset) = web_embed::get_asset("index.html") {
        return asset_response(asset);
    }
    asset_response(web_embed::fallback_html())
}

fn asset_response(asset: web_embed::WebAsset) -> Response {
    let mut res = Response::new(Body::from(asset.bytes.into_owned()));
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&asset.content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    res
}
