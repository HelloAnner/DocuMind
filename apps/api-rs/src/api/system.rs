use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
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
}

async fn overview(
    ActorExtractor(actor): ActorExtractor,
) -> Result<impl IntoResponse, crate::error::AppError> {
    require_super_admin(&actor)?;
    Ok(Json(json!({
        "tenant_count": 18,
        "retrieval_count_24h": 1_200_000i64,
        "generation_success_rate": "99.3%",
        "p95_retrieval_ms": 42,
        "models": [
            { "name": "chat-default", "model": "qwen-plus", "status": "healthy", "throughput": "18 req/min" },
            { "name": "embedding-default", "model": "bge-large-zh", "status": "healthy", "throughput": "240 chunks/min" },
            { "name": "reranker-default", "model": "bge-reranker", "status": "degraded", "throughput": "p95 890ms" },
        ],
        "alerts": [
            { "message": "tenant:acme 向量化队列积压 2,341 个 chunk", "action": "查看任务" },
            { "message": "tenant:beta 本月存储配额使用 86%", "action": "调整配额" },
            { "message": "3 次 LLM provider fallback", "action": "查看日志" },
        ]
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
                    0::bigint as doc_count,
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
    State(_state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, crate::error::AppError> {
    require_super_admin(&actor)?;
    Ok(Json(json!({
        "id": id,
        "name": "Acme Corp",
        "slug": "acme",
        "status": "active",
        "plan": "enterprise",
        "quota": { "kb_limit": 20, "doc_limit": 100000, "monthly_queries": 50000 },
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
    ]))
}

async fn list_models(
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<ModelService>>, crate::error::AppError> {
    require_super_admin(&actor)?;
    Ok(Json(vec![
        ModelService {
            id: Uuid::new_v4(),
            name: "chat-default".to_string(),
            model: "qwen-plus".to_string(),
            base_url: "https://dashscope.aliyuncs.com".to_string(),
            api_key_tail: "9a3c".to_string(),
            status: "healthy".to_string(),
            throughput: "18 req/min".to_string(),
            latency: "p95 230ms".to_string(),
        },
        ModelService {
            id: Uuid::new_v4(),
            name: "embedding-default".to_string(),
            model: "bge-large-zh".to_string(),
            base_url: "https://dashscope.aliyuncs.com".to_string(),
            api_key_tail: "2b1a".to_string(),
            status: "healthy".to_string(),
            throughput: "240 chunks/min".to_string(),
            latency: "p95 45ms".to_string(),
        },
        ModelService {
            id: Uuid::new_v4(),
            name: "reranker-default".to_string(),
            model: "bge-reranker".to_string(),
            base_url: "https://dashscope.aliyuncs.com".to_string(),
            api_key_tail: "7d8e".to_string(),
            status: "degraded".to_string(),
            throughput: "p95 890ms".to_string(),
            latency: "p95 890ms".to_string(),
        },
    ]))
}

async fn list_jobs(
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<JobSummary>>, crate::error::AppError> {
    require_super_admin(&actor)?;
    Ok(Json(vec![
        JobSummary {
            id: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            tenant_name: "acme".to_string(),
            kind: "indexing".to_string(),
            status: "running".to_string(),
            progress: 65,
            created_at: chrono::Utc::now(),
        },
        JobSummary {
            id: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            tenant_name: "beta".to_string(),
            kind: "parsing".to_string(),
            status: "pending".to_string(),
            progress: 0,
            created_at: chrono::Utc::now(),
        },
    ]))
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
