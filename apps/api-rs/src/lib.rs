pub mod agent;
pub mod api;
pub mod auth;
pub mod config;
pub mod error;
pub mod llm;
pub mod models;
pub mod rag;
pub mod repositories;
pub mod state;

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::state::AppState;

pub async fn run() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "documind=info,tower_http=info".into()),
        )
        .init();

    let config = config::load_config()?;
    let host = config.server_host.clone();
    let port = config.server_port;
    let addr: SocketAddr = format!("{host}:{port}").parse()?;

    let state = state::build_state(config).await?;

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(config_snapshot))
        .merge(api::conversations_router())
        .fallback(static_or_spa)
        .with_state(state)
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

async fn config_snapshot(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = &state.config;
    Json(json!({
        "tenant": cfg.default_tenant_id.to_string(),
        "role": cfg.default_role,
        "auth": "disabled",
        "embedding": "bge-large-zh-v1.5",
        "retrieval": {
            "strategy": "hybrid",
            "topK": cfg.rag.retrieval.effective_top_k,
            "rerankTopK": cfg.rag.retrieval.rrf_top_k,
            "threshold": cfg.rag.rerank.min_score
        },
        "agent": {
            "default_tone": cfg.agent.default_tone,
            "proactive_followup": cfg.agent.proactive_followup,
            "max_followup_suggestions": cfg.agent.max_followup_suggestions,
            "allow_analyst_mode": cfg.agent.allow_analyst_mode,
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
