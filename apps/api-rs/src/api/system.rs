use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{require_super_admin, ActorExtractor};
use crate::models::identity::{JobSummary, ModelService, SystemUserSummary, TenantSummary};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/system/overview", get(overview))
        .route("/api/system/tenants", get(list_tenants))
        .route("/api/system/tenants/:id", get(get_tenant))
        .route("/api/system/users", get(list_users))
        .route("/api/system/models", get(list_models))
        .route("/api/system/jobs", get(list_jobs))
        .route("/api/system/audit", get(list_audit))
        .route("/api/system/settings", get(settings))
        .route("/api/system/vector-indexes", get(list_vector_indexes))
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    q: Option<String>,
    limit: Option<i64>,
}

async fn overview(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<impl IntoResponse, crate::error::AppError> {
    require_super_admin(&actor)?;
    if let Some(pool) = &state.db_pool {
        let row = sqlx::query(
            "SELECT
                (SELECT COUNT(*) FROM tenant) AS tenant_count,
                (SELECT COUNT(*) FROM app_user) AS user_count,
                (SELECT COUNT(*) FROM knowledge_base) AS kb_count,
                (SELECT COUNT(*) FROM documents) AS doc_count,
                (SELECT COUNT(*) FROM documents WHERE parse_status = 'indexed') AS indexed_doc_count,
                (SELECT COALESCE(SUM(chunk_count), 0) FROM documents) AS chunk_count,
                (SELECT COUNT(*)
                   FROM document_parse_jobs j
                   JOIN documents d ON d.id = j.doc_id
                  WHERE j.status IN ('pending', 'running')
                    AND d.parse_status NOT IN ('indexed', 'parse_low_confidence', 'ocr_pending')) AS running_jobs,
                (SELECT COUNT(*) FROM documents WHERE parse_status IN ('parse_failed', 'parse_low_confidence', 'ocr_pending', 'embedding_failed', 'parsing', 'parsed')) AS failed_docs",
        )
        .fetch_one(pool)
        .await?;
        return Ok(Json(json!({
            "tenant_count": row.get::<i64, _>("tenant_count"),
            "user_count": row.get::<i64, _>("user_count"),
            "kb_count": row.get::<i64, _>("kb_count"),
            "doc_count": row.get::<i64, _>("doc_count"),
            "indexed_doc_count": row.get::<i64, _>("indexed_doc_count"),
            "chunk_count": row.get::<i64, _>("chunk_count"),
            "running_jobs": row.get::<i64, _>("running_jobs"),
            "failed_docs": row.get::<i64, _>("failed_docs"),
            "models": runtime_models_json(&state),
            "alerts": []
        })));
    }

    Ok(Json(json!({
        "tenant_count": 0,
        "user_count": 0,
        "kb_count": 0,
        "doc_count": 0,
        "indexed_doc_count": 0,
        "chunk_count": 0,
        "running_jobs": 0,
        "failed_docs": 0,
        "models": runtime_models_json(&state),
        "alerts": []
    })))
}

async fn list_tenants(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<TenantSummary>>, crate::error::AppError> {
    require_super_admin(&actor)?;

    if let Some(pool) = &state.db_pool {
        let rows = sqlx::query_as::<_, TenantSummaryRow>(
            "SELECT t.id, t.name, t.slug, t.status, t.plan,
                    COALESCE((SELECT COUNT(*) FROM tenant_member m WHERE m.tenant_id = t.id), 0) as member_count,
                    COALESCE((SELECT COUNT(*) FROM knowledge_base kb WHERE kb.tenant_id = t.id), 0) as kb_count,
                    COALESCE((SELECT COUNT(*) FROM documents d WHERE d.tenant_id = t.id), 0) as doc_count,
                    0::bigint as monthly_queries
             FROM tenant t
             ORDER BY t.created_at DESC"
        )
        .fetch_all(pool)
        .await?;
        return Ok(Json(rows.into_iter().map(|r| r.into()).collect()));
    }

    Ok(Json(vec![TenantSummary {
        id: state.config.default_tenant_id,
        name: "Acme Corp".to_string(),
        slug: "acme".to_string(),
        status: "active".to_string(),
        plan: "enterprise".to_string(),
        member_count: 3,
        kb_count: 3,
        doc_count: 128,
        monthly_queries: 18203,
    }]))
}

async fn get_tenant(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, crate::error::AppError> {
    require_super_admin(&actor)?;
    if let Some(pool) = &state.db_pool {
        let row = sqlx::query(
            "SELECT id, name, slug, status, plan
             FROM tenant
             WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| crate::error::AppError::NotFound {
            code: "TENANT_NOT_FOUND".to_string(),
            message: "租户不存在".to_string(),
        })?;
        return Ok(Json(json!({
            "id": row.get::<Uuid, _>("id"),
            "name": row.get::<String, _>("name"),
            "slug": row.get::<String, _>("slug"),
            "status": row.get::<String, _>("status"),
            "plan": row.get::<String, _>("plan"),
        })));
    }
    Ok(Json(json!({
        "id": id,
        "name": state.config.default_tenant_name,
        "slug": state.config.default_tenant_slug,
        "status": "active",
        "plan": "enterprise",
    })))
}

async fn list_users(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<SystemUserSummary>>, crate::error::AppError> {
    require_super_admin(&actor)?;

    if let Some(pool) = &state.db_pool {
        let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, String)>(
            "SELECT id, email, name, status FROM app_user ORDER BY created_at DESC",
        )
        .fetch_all(pool)
        .await?;

        let mut users = Vec::with_capacity(rows.len());
        for (id, email, name, status) in rows {
            let tenants: Vec<String> = sqlx::query_scalar(
                "SELECT t.name || '(' || UNNEST(tm.roles) || ')'
                 FROM tenant_member tm
                 JOIN tenant t ON t.id = tm.tenant_id
                 WHERE tm.user_id = $1",
            )
            .bind(id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            users.push(SystemUserSummary {
                id,
                email,
                name,
                status,
                tenants,
                last_login_at: None,
            });
        }
        return Ok(Json(users));
    }

    Ok(Json(vec![
        SystemUserSummary {
            id: Uuid::new_v4(),
            email: "ops@documind.local".to_string(),
            name: Some("Ops".to_string()),
            status: "active".to_string(),
            tenants: vec!["Acme(super_admin)".to_string()],
            last_login_at: None,
        },
        SystemUserSummary {
            id: Uuid::new_v4(),
            email: "admin@documind.local".to_string(),
            name: Some("Admin".to_string()),
            status: "active".to_string(),
            tenants: vec!["Acme(enterprise_admin)".to_string()],
            last_login_at: None,
        },
        SystemUserSummary {
            id: Uuid::new_v4(),
            email: "dev@documind.local".to_string(),
            name: Some("Dev".to_string()),
            status: "active".to_string(),
            tenants: vec!["Acme(admin)".to_string()],
            last_login_at: None,
        },
    ]))
}

async fn list_models(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<ModelService>>, crate::error::AppError> {
    require_super_admin(&actor)?;
    Ok(Json(vec![
        ModelService {
            id: Uuid::new_v4(),
            name: "chat-default".to_string(),
            model: state.config.rag.generation.model.clone(),
            base_url: state.config.rag.generation.base_url.clone(),
            api_key_tail: tail(&state.config.rag.generation.api_key),
            status: if state.config.rag.generation.use_real_llm {
                "configured"
            } else {
                "mock"
            }
            .to_string(),
            throughput: "not_measured".to_string(),
            latency: "not_measured".to_string(),
        },
        ModelService {
            id: Uuid::new_v4(),
            name: "embedding-default".to_string(),
            model: state.config.rag.embedding.model.clone(),
            base_url: state.config.rag.embedding.base_url.clone(),
            api_key_tail: state
                .config
                .rag
                .embedding
                .api_key
                .as_deref()
                .map(tail)
                .unwrap_or_else(|| "unset".to_string()),
            status: if state.config.rag.embedding.enabled {
                "configured"
            } else {
                "disabled"
            }
            .to_string(),
            throughput: "not_measured".to_string(),
            latency: "not_measured".to_string(),
        },
        ModelService {
            id: Uuid::new_v4(),
            name: "reranker-default".to_string(),
            model: state.config.rag.rerank.model.clone(),
            base_url: state.config.rag.rerank.api_url.clone().unwrap_or_default(),
            api_key_tail: state
                .config
                .rag
                .rerank
                .api_key
                .as_deref()
                .map(tail)
                .unwrap_or_else(|| "unset".to_string()),
            status: reranker_status(&state).to_string(),
            throughput: "not_measured".to_string(),
            latency: "not_measured".to_string(),
        },
    ]))
}

async fn list_jobs(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<JobSummary>>, crate::error::AppError> {
    require_super_admin(&actor)?;
    if let Some(pool) = &state.db_pool {
        reconcile_terminal_document_jobs(pool).await?;
        let rows = sqlx::query(
            "SELECT j.parse_job_id, j.tenant_id, t.slug AS tenant_name, j.status,
                    COALESCE((d.metadata->>'parse_progress')::int, 0) AS progress,
                    j.created_at
             FROM document_parse_jobs j
             JOIN tenant t ON t.id = j.tenant_id
             JOIN documents d ON d.id = j.doc_id
             ORDER BY j.created_at DESC
             LIMIT 100",
        )
        .fetch_all(pool)
        .await?;
        return Ok(Json(
            rows.into_iter()
                .map(|row| JobSummary {
                    id: row.get("parse_job_id"),
                    tenant_id: row.get("tenant_id"),
                    tenant_name: row.get("tenant_name"),
                    kind: "document_parse".to_string(),
                    status: row.get("status"),
                    progress: row.get("progress"),
                    created_at: row.get("created_at"),
                })
                .collect(),
        ));
    }

    Ok(Json(vec![]))
}

async fn settings(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    require_super_admin(&actor)?;
    let cfg = &state.config;
    Ok(Json(json!({
        "read_only": true,
        "environment": cfg.environment.as_str(),
        "service": {
            "host": cfg.server_host,
            "port": cfg.server_port,
            "base_path": "/documind",
            "health_path": "/api/health"
        },
        "auth": {
            "login_mode": cfg.auth_login_mode,
            "token_expire_hours": cfg.auth_token_expire_hours,
            "portal_base_url": cfg.portal_base_url,
            "portal_exchange_endpoint": cfg.portal_exchange_endpoint,
            "local_login_enabled": cfg.auth_login_mode == "local",
            "portal_login_enabled": cfg.auth_login_mode == "portal"
        },
        "storage": {
            "database_configured": cfg.database_url.as_ref().is_some_and(|v| !v.trim().is_empty()),
            "redis_configured": cfg.redis_url.as_ref().is_some_and(|v| !v.trim().is_empty()),
            "rabbitmq_configured": cfg.rabbitmq_url.as_ref().is_some_and(|v| !v.trim().is_empty()),
            "elasticsearch_configured": cfg.elasticsearch_url.as_ref().is_some_and(|v| !v.trim().is_empty()),
            "object_storage_provider": cfg.object_storage_provider,
            "object_storage_endpoint_configured": cfg.object_storage_endpoint.as_ref().is_some_and(|v| !v.trim().is_empty()),
            "object_storage_region": cfg.object_storage_region,
            "object_storage_bucket": cfg.object_storage_bucket,
            "object_storage_force_path_style": cfg.object_storage_force_path_style,
            "object_storage_tls_verify": cfg.object_storage_tls_verify,
            "object_storage_presign_expire_seconds": cfg.object_storage_presign_expire_seconds
        },
        "deployment": {
            "host_alias": "documind",
            "root": "/opt/documind",
            "current": "/opt/documind/current",
            "releases": "/opt/documind/releases/<timestamp>",
            "shared": "/opt/documind/shared",
            "env_file": "/opt/documind/shared/.env",
            "log_file": "/opt/documind/shared/logs/documind-8089.log",
            "containers": [
                "documind-postgres",
                "documind-redis",
                "documind-rabbitmq",
                "documind-elasticsearch",
                "documind-minio"
            ]
        }
    })))
}

async fn list_vector_indexes(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<serde_json::Value>>, crate::error::AppError> {
    require_super_admin(&actor)?;
    let Some(pool) = &state.db_pool else {
        return Ok(Json(vec![]));
    };
    let es_doc_count = elasticsearch_index_count(&state).await.unwrap_or_default();
    let rows = sqlx::query(
        "SELECT t.id AS tenant_id,
                t.name AS tenant_name,
                kb.id AS kb_id,
                kb.name AS kb_name,
                COALESCE(e.embedding_model, $1) AS embedding_model,
                COALESCE(MAX(e.embedding_dim), 0)::int AS embedding_dim,
                COUNT(DISTINCT d.id) FILTER (WHERE d.parse_status = 'indexed')::bigint AS indexed_documents,
                COUNT(DISTINCT d.id) FILTER (
                    WHERE d.parse_status IN ('uploaded', 'parsing', 'chunked', 'embedding')
                )::bigint AS building_documents,
                COUNT(DISTINCT d.id) FILTER (
                    WHERE d.parse_status IN ('parse_failed', 'parse_low_confidence', 'ocr_pending', 'embedding_failed', 'parsed')
                )::bigint AS degraded_documents,
                COUNT(DISTINCT c.id)::bigint AS chunks,
                COUNT(DISTINCT e.chunk_id) FILTER (WHERE e.status = 'completed')::bigint AS embedded_chunks,
                COUNT(DISTINCT e.chunk_id) FILTER (WHERE e.status <> 'completed')::bigint AS failed_embeddings,
                MAX(e.embedded_at) AS last_indexed_at
         FROM knowledge_base kb
         JOIN tenant t ON t.id = kb.tenant_id
         LEFT JOIN documents d
                ON d.kb_id = kb.id
               AND d.tenant_id = kb.tenant_id
               AND d.parse_status <> 'deleted'
         LEFT JOIN chunks c
                ON c.doc_id = d.id
               AND c.tenant_id = d.tenant_id
               AND c.kb_id = d.kb_id
               AND c.parse_job_id = d.latest_parse_job_id
         LEFT JOIN chunk_embeddings e
                ON e.chunk_id = c.id
               AND e.embedding_model = $1
         GROUP BY t.id, t.name, kb.id, kb.name, COALESCE(e.embedding_model, $1)
         ORDER BY t.name ASC, kb.name ASC",
    )
    .bind(&state.config.rag.embedding.model)
    .fetch_all(pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let chunks = row.get::<i64, _>("chunks");
                let embedded_chunks = row.get::<i64, _>("embedded_chunks");
                let building_documents = row.get::<i64, _>("building_documents");
                let degraded_documents = row.get::<i64, _>("degraded_documents");
                let failed_embeddings = row.get::<i64, _>("failed_embeddings");
                let status = if building_documents > 0 {
                    "building"
                } else if degraded_documents > 0
                    || failed_embeddings > 0
                    || embedded_chunks < chunks
                {
                    "degraded"
                } else {
                    "healthy"
                };
                let kb_id = row.get::<Uuid, _>("kb_id");
                json!({
                    "id": format!("{}:{}", kb_id, row.get::<String, _>("embedding_model")),
                    "name": state.config.rag.embedding.index_name.clone(),
                    "alias": state.config.rag.embedding.index_alias.clone(),
                    "tenant_id": row.get::<Uuid, _>("tenant_id"),
                    "tenant": row.get::<String, _>("tenant_name"),
                    "kb_id": kb_id,
                    "kb_name": row.get::<String, _>("kb_name"),
                    "embedding_model": row.get::<String, _>("embedding_model"),
                    "index_version": format!(
                        "{}:{}",
                        state.config.rag.embedding.index_alias,
                        row.get::<String, _>("embedding_model")
                    ),
                    "dimension": row.get::<i32, _>("embedding_dim"),
                    "documents": row.get::<i64, _>("indexed_documents"),
                    "building_documents": building_documents,
                    "degraded_documents": degraded_documents,
                    "chunks": chunks,
                    "embedded_chunks": embedded_chunks,
                    "es_documents": es_doc_count,
                    "status": status,
                    "lastIndexed": row
                        .get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_indexed_at")
                        .map(|value| value.to_rfc3339()),
                })
            })
            .collect(),
    ))
}

async fn elasticsearch_index_count(state: &AppState) -> Result<i64, crate::error::AppError> {
    let Some(base_url) = &state.config.elasticsearch_url else {
        return Ok(0);
    };
    let url = format!(
        "{}/{}/_count",
        base_url.trim_end_matches('/'),
        state.config.rag.embedding.index_name
    );
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    Ok(response
        .get("count")
        .and_then(|value| value.as_i64())
        .unwrap_or_default())
}

async fn list_audit(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Vec<serde_json::Value>>, crate::error::AppError> {
    require_super_admin(&actor)?;
    let Some(pool) = &state.db_pool else {
        return Ok(Json(vec![]));
    };
    let search = query
        .q
        .as_ref()
        .map(|q| q.trim())
        .filter(|q| !q.is_empty())
        .map(|q| format!("%{q}%"));
    let limit = query.limit.unwrap_or(200).clamp(1, 500);
    let rows = sqlx::query(
        "SELECT a.id,
                COALESCE(t.name, 'system') AS tenant_name,
                COALESCE(u.name, u.email, a.actor_role, 'anonymous') AS actor_name,
                COALESCE(a.actor_role, 'anonymous') AS actor_role,
                a.action,
                COALESCE(a.resource_type, '') AS resource_type,
                COALESCE(a.resource_id, '') AS resource_id,
                COALESCE(a.ip, '') AS ip,
                a.detail,
                a.created_at
         FROM audit_log a
         LEFT JOIN tenant t ON t.id = a.tenant_id
         LEFT JOIN app_user u ON u.id = a.actor_user_id
         WHERE $1::text IS NULL
            OR a.action ILIKE $1
            OR COALESCE(a.resource_type, '') ILIKE $1
            OR COALESCE(a.resource_id, '') ILIKE $1
            OR COALESCE(u.name, '') ILIKE $1
            OR COALESCE(u.email, '') ILIKE $1
         ORDER BY a.created_at DESC
         LIMIT $2",
    )
    .bind(search)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| {
                json!({
                    "id": row.get::<Uuid, _>("id"),
                    "time": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                    "tenant": row.get::<String, _>("tenant_name"),
                    "user": row.get::<String, _>("actor_name"),
                    "role": row.get::<String, _>("actor_role"),
                    "action": row.get::<String, _>("action"),
                    "resource_type": row.get::<String, _>("resource_type"),
                    "resource_id": row.get::<String, _>("resource_id"),
                    "resource": format!(
                        "{}:{}",
                        row.get::<String, _>("resource_type"),
                        row.get::<String, _>("resource_id")
                    ),
                    "ip": row.get::<String, _>("ip"),
                    "detail": row.get::<serde_json::Value, _>("detail"),
                })
            })
            .collect(),
    ))
}

async fn reconcile_terminal_document_jobs(
    pool: &sqlx::PgPool,
) -> Result<(), crate::error::AppError> {
    sqlx::query(
        "UPDATE document_parse_jobs j
         SET status = 'completed',
             completed_at = COALESCE(j.completed_at, NOW())
         FROM documents d
         WHERE d.id = j.doc_id
           AND j.status IN ('pending', 'running')
           AND d.parse_status IN ('indexed', 'parse_low_confidence')",
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn runtime_models_json(state: &AppState) -> serde_json::Value {
    json!([
        {
            "name": "chat-default",
            "model": state.config.rag.generation.model,
            "status": if state.config.rag.generation.use_real_llm { "configured" } else { "mock" }
        },
        {
            "name": "embedding-default",
            "model": state.config.rag.embedding.model,
            "status": if state.config.rag.embedding.enabled { "configured" } else { "disabled" }
        },
        {
            "name": "reranker-default",
            "model": state.config.rag.rerank.model,
            "status": reranker_status(state)
        }
    ])
}

fn reranker_status(state: &AppState) -> &'static str {
    if !state.config.rag.rerank.enabled {
        "disabled"
    } else if state.config.rag.rerank.api_url.is_some() {
        "configured"
    } else {
        "lexical_fallback"
    }
}

fn tail(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().rev().take(4).collect();
    chars.into_iter().rev().collect()
}

#[derive(sqlx::FromRow)]
struct TenantSummaryRow {
    id: Uuid,
    name: String,
    slug: String,
    status: String,
    plan: String,
    member_count: i64,
    kb_count: i64,
    doc_count: i64,
    monthly_queries: i64,
}

impl From<TenantSummaryRow> for TenantSummary {
    fn from(r: TenantSummaryRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            slug: r.slug,
            status: r.status,
            plan: r.plan,
            member_count: r.member_count,
            kb_count: r.kb_count,
            doc_count: r.doc_count,
            monthly_queries: r.monthly_queries,
        }
    }
}
