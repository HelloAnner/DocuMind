#![recursion_limit = "256"]

pub mod agent;
pub mod api;
pub mod auth;
pub mod config;
pub mod document;
pub mod error;
pub mod llm;
pub mod models;
pub mod rag;
pub mod repositories;
pub mod state;
pub mod storage;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use reqwest::StatusCode as HttpStatusCode;
use serde_json::json;
use sqlx::PgPool;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::state::AppState;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

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
    let api_routes = api_routes();

    let app = Router::new()
        .merge(api_routes.clone())
        .nest("/documind", api_routes)
        .fallback(static_or_spa)
        .with_state(state)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "DocuMind runtime listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn api_routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/metrics", get(metrics))
        .route("/api/config", get(config_snapshot))
        .merge(api::auth_router())
        .merge(api::account_router())
        .merge(api::system_router())
        .merge(api::admin_router())
        .merge(api::admin_members_router())
        .merge(api::documents_router())
        .merge(api::knowledge_router())
        .merge(api::history_router())
        .merge(api::conversations_router())
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let http_client = reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .build()
        .ok();
    let postgres = check_postgres(state.db_pool.as_ref()).await;
    let redis = check_redis(state.redis_client.as_ref()).await;
    let elasticsearch = check_elasticsearch(
        http_client.as_ref(),
        state.config.elasticsearch_url.as_deref(),
    )
    .await;
    let object_storage = check_object_storage(
        http_client.as_ref(),
        state.config.object_storage_provider.as_str(),
        state.config.object_storage_endpoint.as_deref(),
        state.config.object_storage_bucket.as_str(),
    )
    .await;
    let rabbitmq = check_tcp_url(state.config.rabbitmq_url.as_deref(), 5672).await;
    let real_llm = check_openai_compatible_endpoint(
        http_client.as_ref(),
        state.config.rag.generation.use_real_llm,
        state.config.rag.generation.base_url.as_str(),
        Some(state.config.rag.generation.api_key.as_str()),
        "LLM",
    )
    .await
    .with_field("model", state.config.rag.generation.model.as_str());
    let embedding = check_openai_compatible_endpoint(
        http_client.as_ref(),
        state.config.rag.embedding.enabled,
        state.config.rag.embedding.base_url.as_str(),
        state.config.rag.embedding.api_key.as_deref(),
        "Embedding",
    )
    .await
    .with_field("model", state.config.rag.embedding.model.as_str())
    .with_field("index", state.config.rag.embedding.index_name.as_str());
    let vector_consistency = match (&state.db_pool, state.config.elasticsearch_url.as_deref()) {
        (Some(pool), Some(es_url)) => crate::rag::vector_pipeline::quick_consistency(
            pool,
            &state.config.rag.embedding,
            es_url,
        )
        .await
        .map_err(|error| error.to_string()),
        _ => Err("vector index dependencies are not configured".to_string()),
    };
    let vector_index_consistent = vector_consistency
        .as_ref()
        .map(|snapshot| snapshot.consistent)
        .unwrap_or(false);
    let ok = [
        postgres.ok,
        redis.ok,
        elasticsearch.ok,
        object_storage.ok,
        rabbitmq.ok,
        real_llm.ok,
        embedding.ok,
        vector_index_consistent,
    ]
    .into_iter()
    .all(|item| item);

    Json(json!({
        "ok": ok,
        "service": "documind",
        "mode": "release",
        "environment": state.config.environment.as_str(),
        "version": env!("CARGO_PKG_VERSION"),
        "checks": {
            "postgres": postgres.ok,
            "redis": redis.ok,
            "elasticsearch": elasticsearch.ok,
            "object_storage": object_storage.ok,
            "rabbitmq": rabbitmq.ok,
            "real_llm": real_llm.ok,
            "embedding": embedding.ok,
            "vector_index_consistent": vector_index_consistent
        },
        "details": {
            "postgres": postgres.into_json(),
            "redis": redis.into_json(),
            "elasticsearch": elasticsearch.into_json(),
            "object_storage": object_storage.into_json(),
            "rabbitmq": rabbitmq.into_json(),
            "real_llm": real_llm.into_json(),
            "embedding": embedding.into_json(),
            "vector_index": match vector_consistency {
                Ok(snapshot) => json!(snapshot),
                Err(error) => json!({"consistent": false, "error": error})
            }
        }
    }))
}

async fn metrics(State(state): State<AppState>) -> Response {
    let http_client = reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .build()
        .ok();
    let postgres = check_postgres(state.db_pool.as_ref()).await;
    let redis = check_redis(state.redis_client.as_ref()).await;
    let elasticsearch = check_elasticsearch(
        http_client.as_ref(),
        state.config.elasticsearch_url.as_deref(),
    )
    .await;
    let object_storage = check_object_storage(
        http_client.as_ref(),
        state.config.object_storage_provider.as_str(),
        state.config.object_storage_endpoint.as_deref(),
        state.config.object_storage_bucket.as_str(),
    )
    .await;
    let rabbitmq = check_tcp_url(state.config.rabbitmq_url.as_deref(), 5672).await;
    let real_llm = check_openai_compatible_endpoint(
        http_client.as_ref(),
        state.config.rag.generation.use_real_llm,
        state.config.rag.generation.base_url.as_str(),
        Some(state.config.rag.generation.api_key.as_str()),
        "LLM",
    )
    .await;
    let embedding = check_openai_compatible_endpoint(
        http_client.as_ref(),
        state.config.rag.embedding.enabled,
        state.config.rag.embedding.base_url.as_str(),
        state.config.rag.embedding.api_key.as_deref(),
        "Embedding",
    )
    .await;

    let mut out = String::new();
    out.push_str("# HELP documind_up Whether the DocuMind process can render metrics.\n");
    out.push_str("# TYPE documind_up gauge\n");
    push_metric(&mut out, "documind_up", &[], 1);
    out.push_str("# HELP documind_dependency_up Dependency health from the same probes used by /api/health.\n");
    out.push_str("# TYPE documind_dependency_up gauge\n");
    for (name, check) in [
        ("postgres", &postgres),
        ("redis", &redis),
        ("elasticsearch", &elasticsearch),
        ("object_storage", &object_storage),
        ("rabbitmq", &rabbitmq),
        ("real_llm", &real_llm),
        ("embedding", &embedding),
    ] {
        push_metric(
            &mut out,
            "documind_dependency_up",
            &[("dependency", name)],
            if check.ok { 1 } else { 0 },
        );
    }

    if let Some(pool) = &state.db_pool {
        match append_database_metrics(&mut out, pool).await {
            Ok(()) => push_metric(&mut out, "documind_database_metrics_available", &[], 1),
            Err(err) => {
                push_metric(&mut out, "documind_database_metrics_available", &[], 0);
                out.push_str(&format!(
                    "# documind_database_metrics_error {}\n",
                    sanitize_prometheus_comment(&err.to_string())
                ));
            }
        }
        if let Some(es_url) = state.config.elasticsearch_url.as_deref() {
            match crate::rag::vector_pipeline::quick_consistency(
                pool,
                &state.config.rag.embedding,
                es_url,
            )
            .await
            {
                Ok(snapshot) => {
                    push_metric(
                        &mut out,
                        "documind_vector_index_expected_chunks",
                        &[],
                        snapshot.expected_chunks,
                    );
                    push_metric(
                        &mut out,
                        "documind_vector_index_actual_chunks",
                        &[],
                        snapshot.actual_chunks,
                    );
                    push_metric(
                        &mut out,
                        "documind_vector_index_drift_chunks",
                        &[],
                        snapshot.missing_or_stale_chunks,
                    );
                }
                Err(err) => out.push_str(&format!(
                    "# documind_vector_consistency_error {}\n",
                    sanitize_prometheus_comment(&err.to_string())
                )),
            }
        }
    } else {
        push_metric(&mut out, "documind_database_metrics_available", &[], 0);
    }

    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
        )],
        out,
    )
        .into_response()
}

async fn append_database_metrics(out: &mut String, pool: &PgPool) -> anyhow::Result<()> {
    out.push_str("# HELP documind_documents_total Total number of non-deleted documents.\n");
    out.push_str("# TYPE documind_documents_total gauge\n");
    let documents_total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM documents WHERE parse_status <> 'deleted'")
            .fetch_one(pool)
            .await?;
    push_metric(out, "documind_documents_total", &[], documents_total);

    out.push_str("# HELP documind_documents_by_status_total Documents grouped by parse_status.\n");
    out.push_str("# TYPE documind_documents_by_status_total gauge\n");
    let document_statuses = sqlx::query_as::<_, (String, i64)>(
        "SELECT parse_status, COUNT(*)::bigint
         FROM documents
         WHERE parse_status <> 'deleted'
         GROUP BY parse_status
         ORDER BY parse_status",
    )
    .fetch_all(pool)
    .await?;
    for (status, count) in document_statuses {
        push_metric(
            out,
            "documind_documents_by_status_total",
            &[("status", status.as_str())],
            count,
        );
    }

    out.push_str("# HELP documind_document_chunks_total Sum of chunk_count across documents.\n");
    out.push_str("# TYPE documind_document_chunks_total gauge\n");
    let chunks_total: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(chunk_count), 0)::bigint
         FROM documents
         WHERE parse_status <> 'deleted'",
    )
    .fetch_one(pool)
    .await?;
    push_metric(out, "documind_document_chunks_total", &[], chunks_total);

    out.push_str("# HELP documind_parse_jobs_by_status_total Parse jobs grouped by status.\n");
    out.push_str("# TYPE documind_parse_jobs_by_status_total gauge\n");
    let parse_jobs = sqlx::query_as::<_, (String, i64)>(
        "SELECT status, COUNT(*)::bigint
         FROM document_parse_jobs
         GROUP BY status
         ORDER BY status",
    )
    .fetch_all(pool)
    .await?;
    for (status, count) in parse_jobs {
        push_metric(
            out,
            "documind_parse_jobs_by_status_total",
            &[("status", status.as_str())],
            count,
        );
    }

    out.push_str(
        "# HELP documind_vector_jobs_by_status_total Durable vector jobs grouped by status.\n",
    );
    out.push_str("# TYPE documind_vector_jobs_by_status_total gauge\n");
    let vector_jobs = sqlx::query_as::<_, (String, i64)>(
        "SELECT status, COUNT(*)::bigint FROM vector_jobs GROUP BY status ORDER BY status",
    )
    .fetch_all(pool)
    .await?;
    for (status, count) in vector_jobs {
        push_metric(
            out,
            "documind_vector_jobs_by_status_total",
            &[("status", status.as_str())],
            count,
        );
    }

    out.push_str("# HELP documind_embeddings_by_status_total Chunk embeddings grouped by generation and index status.\n");
    out.push_str("# TYPE documind_embeddings_by_status_total gauge\n");
    let embedding_statuses = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT status, index_status, COUNT(*)::bigint
         FROM chunk_embeddings GROUP BY status, index_status ORDER BY status, index_status",
    )
    .fetch_all(pool)
    .await?;
    for (status, index_status, count) in embedding_statuses {
        push_metric(
            out,
            "documind_embeddings_by_status_total",
            &[
                ("status", status.as_str()),
                ("index_status", index_status.as_str()),
            ],
            count,
        );
    }

    out.push_str("# HELP documind_conversations_total Total conversation sessions.\n");
    out.push_str("# TYPE documind_conversations_total gauge\n");
    let conversations_total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_sessions")
        .fetch_one(pool)
        .await?;
    push_metric(
        out,
        "documind_conversations_total",
        &[],
        conversations_total,
    );

    out.push_str("# HELP documind_messages_by_role_total Conversation messages grouped by role.\n");
    out.push_str("# TYPE documind_messages_by_role_total gauge\n");
    let message_roles = sqlx::query_as::<_, (String, i64)>(
        "SELECT role, COUNT(*)::bigint
         FROM conversation_messages
         GROUP BY role
         ORDER BY role",
    )
    .fetch_all(pool)
    .await?;
    for (role, count) in message_roles {
        push_metric(
            out,
            "documind_messages_by_role_total",
            &[("role", role.as_str())],
            count,
        );
    }

    out.push_str("# HELP documind_feedback_total Total conversation feedback rows.\n");
    out.push_str("# TYPE documind_feedback_total gauge\n");
    let feedback_total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_feedback")
        .fetch_one(pool)
        .await?;
    push_metric(out, "documind_feedback_total", &[], feedback_total);

    Ok(())
}

fn push_metric(out: &mut String, name: &str, labels: &[(&str, &str)], value: impl ToString) {
    out.push_str(name);
    if !labels.is_empty() {
        out.push('{');
        for (index, (key, value)) in labels.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(key);
            out.push_str("=\"");
            out.push_str(&escape_prometheus_label(value));
            out.push('"');
        }
        out.push('}');
    }
    out.push(' ');
    out.push_str(&value.to_string());
    out.push('\n');
}

fn escape_prometheus_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

fn sanitize_prometheus_comment(value: &str) -> String {
    value.replace('\n', " ")
}

#[derive(Debug)]
struct DependencyCheck {
    ok: bool,
    reason: Option<String>,
    fields: BTreeMap<String, serde_json::Value>,
}

impl DependencyCheck {
    fn ok() -> Self {
        Self {
            ok: true,
            reason: None,
            fields: BTreeMap::new(),
        }
    }

    fn failed(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            reason: Some(reason.into()),
            fields: BTreeMap::new(),
        }
    }

    fn with_field(mut self, key: &str, value: impl Into<serde_json::Value>) -> Self {
        self.fields.insert(key.to_string(), value.into());
        self
    }

    fn into_json(self) -> serde_json::Value {
        let mut payload = serde_json::Map::new();
        payload.insert("ok".to_string(), json!(self.ok));
        if let Some(reason) = self.reason {
            payload.insert("reason".to_string(), json!(reason));
        }
        for (key, value) in self.fields {
            payload.insert(key, value);
        }
        serde_json::Value::Object(payload)
    }
}

async fn check_postgres(pool: Option<&PgPool>) -> DependencyCheck {
    let Some(pool) = pool else {
        return DependencyCheck::failed("DATABASE_URL is not configured");
    };
    match timeout(
        HEALTH_TIMEOUT,
        sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(pool),
    )
    .await
    {
        Ok(Ok(1)) => DependencyCheck::ok(),
        Ok(Ok(_)) => DependencyCheck::failed("unexpected database health response"),
        Ok(Err(err)) => DependencyCheck::failed(err.to_string()),
        Err(_) => DependencyCheck::failed("database health check timed out"),
    }
}

async fn check_redis(client: Option<&redis::Client>) -> DependencyCheck {
    let Some(client) = client else {
        return DependencyCheck::failed("REDIS_URL is not configured");
    };
    let mut conn = match timeout(HEALTH_TIMEOUT, client.get_multiplexed_async_connection()).await {
        Ok(Ok(conn)) => conn,
        Ok(Err(err)) => return DependencyCheck::failed(err.to_string()),
        Err(_) => return DependencyCheck::failed("redis connection timed out"),
    };
    let result: redis::RedisResult<String> =
        timeout(HEALTH_TIMEOUT, redis::cmd("PING").query_async(&mut conn))
            .await
            .unwrap_or_else(|_| {
                Err(redis::RedisError::from((
                    redis::ErrorKind::IoError,
                    "redis ping timed out",
                )))
            });
    match result {
        Ok(value) if value == "PONG" => DependencyCheck::ok(),
        Ok(value) => DependencyCheck::failed(format!("unexpected redis ping response: {value}")),
        Err(err) => DependencyCheck::failed(err.to_string()),
    }
}

async fn check_elasticsearch(
    http_client: Option<&reqwest::Client>,
    url: Option<&str>,
) -> DependencyCheck {
    let Some(url) = present(url, "ELASTICSEARCH_URL") else {
        return DependencyCheck::failed("ELASTICSEARCH_URL is not configured");
    };
    let endpoint = format!("{}/_cluster/health", url.trim_end_matches('/'));
    check_http_get(http_client, &endpoint, "elasticsearch").await
}

async fn check_object_storage(
    http_client: Option<&reqwest::Client>,
    provider: &str,
    endpoint: Option<&str>,
    bucket: &str,
) -> DependencyCheck {
    let Some(endpoint) = present(endpoint, "OBJECT_STORAGE_ENDPOINT") else {
        return DependencyCheck::failed("OBJECT_STORAGE_ENDPOINT is not configured");
    };
    let url = if provider.eq_ignore_ascii_case("minio") {
        format!("{}/minio/health/live", endpoint.trim_end_matches('/'))
    } else {
        endpoint.to_string()
    };
    check_http_get(http_client, &url, "object storage")
        .await
        .with_field("provider", provider)
        .with_field("bucket", bucket)
}

async fn check_openai_compatible_endpoint(
    http_client: Option<&reqwest::Client>,
    enabled: bool,
    base_url: &str,
    api_key: Option<&str>,
    label: &str,
) -> DependencyCheck {
    if !enabled {
        return DependencyCheck::failed(format!("{label} is disabled"));
    }
    let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) else {
        return DependencyCheck::failed(format!("{label} API key is not configured"));
    };
    let Some(http_client) = http_client else {
        return DependencyCheck::failed("health http client is unavailable");
    };
    let url = openai_models_url(base_url);
    let response = timeout(
        HEALTH_TIMEOUT,
        http_client.get(url).bearer_auth(api_key).send(),
    )
    .await;
    match response {
        Ok(Ok(resp)) if resp.status().is_success() => DependencyCheck::ok(),
        Ok(Ok(resp)) => {
            DependencyCheck::failed(format!("{label} provider returned HTTP {}", resp.status()))
        }
        Ok(Err(err)) => DependencyCheck::failed(err.to_string()),
        Err(_) => DependencyCheck::failed(format!("{label} provider health check timed out")),
    }
}

async fn check_tcp_url(url: Option<&str>, default_port: u16) -> DependencyCheck {
    let Some(url) = present(url, "RABBITMQ_URL") else {
        return DependencyCheck::failed("RABBITMQ_URL is not configured");
    };
    let Some((host, port)) = parse_host_port(url, default_port) else {
        return DependencyCheck::failed("RABBITMQ_URL host or port is invalid");
    };
    match timeout(HEALTH_TIMEOUT, TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(_)) => DependencyCheck::ok()
            .with_field("host", host)
            .with_field("port", port),
        Ok(Err(err)) => DependencyCheck::failed(err.to_string())
            .with_field("host", host)
            .with_field("port", port),
        Err(_) => DependencyCheck::failed("rabbitmq tcp connection timed out")
            .with_field("host", host)
            .with_field("port", port),
    }
}

async fn check_http_get(
    http_client: Option<&reqwest::Client>,
    url: &str,
    label: &str,
) -> DependencyCheck {
    let Some(http_client) = http_client else {
        return DependencyCheck::failed("health http client is unavailable");
    };
    let response = timeout(HEALTH_TIMEOUT, http_client.get(url).send()).await;
    match response {
        Ok(Ok(resp)) if http_status_allows_reachable(resp.status()) => DependencyCheck::ok(),
        Ok(Ok(resp)) => DependencyCheck::failed(format!("{label} returned HTTP {}", resp.status())),
        Ok(Err(err)) => DependencyCheck::failed(err.to_string()),
        Err(_) => DependencyCheck::failed(format!("{label} health check timed out")),
    }
}

fn http_status_allows_reachable(status: HttpStatusCode) -> bool {
    status.is_success()
        || status == HttpStatusCode::UNAUTHORIZED
        || status == HttpStatusCode::FORBIDDEN
}

fn present<'a>(value: Option<&'a str>, _name: &str) -> Option<&'a str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn openai_models_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/embeddings") {
        let parent = base.trim_end_matches("/embeddings");
        format!("{parent}/models")
    } else if base.ends_with("/chat/completions") {
        let parent = base.trim_end_matches("/chat/completions");
        format!("{parent}/models")
    } else {
        format!("{base}/models")
    }
}

fn parse_host_port(raw_url: &str, default_port: u16) -> Option<(String, u16)> {
    let after_scheme = raw_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(raw_url);
    let authority = after_scheme.split('/').next()?.trim();
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, value)| value)
        .unwrap_or(authority)
        .trim();
    if host_port.is_empty() {
        return None;
    }
    if let Some(rest) = host_port.strip_prefix('[') {
        let (host, after_host) = rest.split_once(']')?;
        let port = after_host
            .strip_prefix(':')
            .and_then(|value| value.parse().ok())
            .unwrap_or(default_port);
        return Some((host.to_string(), port));
    }
    if let Some((host, port)) = host_port.rsplit_once(':') {
        let port = port.parse().ok()?;
        if host.trim().is_empty() {
            return None;
        }
        return Some((host.to_string(), port));
    }
    Some((host_port.to_string(), default_port))
}

async fn config_snapshot(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = &state.config;
    Json(json!({
        "tenant": cfg.default_tenant_id.to_string(),
        "role": cfg.default_role,
        "auth": "jwt",
        "environment": cfg.environment.as_str(),
        "storage": {
            "provider": &cfg.object_storage_provider,
            "blob_dir": &cfg.blob_storage_dir,
            "object_endpoint": &cfg.object_storage_endpoint,
            "object_region": &cfg.object_storage_region,
            "object_bucket": &cfg.object_storage_bucket,
            "object_force_path_style": cfg.object_storage_force_path_style,
            "object_tls_verify": cfg.object_storage_tls_verify,
            "elasticsearch": &cfg.elasticsearch_url,
            "rabbitmq": &cfg.rabbitmq_url,
            "redis": &cfg.redis_url,
        },
        "embedding": {
            "enabled": cfg.rag.embedding.enabled,
            "model": &cfg.rag.embedding.model,
            "base_url": &cfg.rag.embedding.base_url,
            "index": &cfg.rag.embedding.index_name,
            "alias": &cfg.rag.embedding.index_alias
        },
        "retrieval": {
            "strategy": "hybrid",
            "topK": cfg.rag.retrieval.effective_top_k,
            "rerankTopK": cfg.rag.retrieval.rrf_top_k,
            "threshold": cfg.rag.rerank.min_score
        },
        "llm": {
            "use_real_llm": cfg.rag.generation.use_real_llm,
            "model": &cfg.rag.generation.model,
            "base_url": &cfg.rag.generation.base_url,
            "streaming_enabled": cfg.rag.generation.use_real_llm,
            "mock_enabled": !cfg.rag.generation.use_real_llm,
            "temperature": cfg.rag.generation.temperature,
            "max_output_tokens": cfg.rag.generation.max_output_tokens
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
