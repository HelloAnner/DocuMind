use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{require_tenant_admin, ActorExtractor};
use crate::models::identity::{KnowledgeBaseSummary, MemberSummary, QaLogSummary};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/overview", get(overview))
        .route("/api/admin/knowledge-bases", get(list_knowledge_bases))
        .route("/api/admin/documents", get(list_documents))
        .route("/api/admin/members", get(list_members))
        .route("/api/admin/logs", get(list_logs))
}

async fn overview(
    ActorExtractor(actor): ActorExtractor,
) -> Result<impl IntoResponse, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    Ok(Json(json!({
        "doc_count": 12483,
        "active_users": 47,
        "hit_rate": "87%",
        "p95_answer_ms": 1800,
        "knowledge_bases": [
            { "name": "产品文档库", "doc_count": 3201, "status": "healthy", "today_queries": 1204 },
            { "name": "销售资料库", "doc_count": 1044, "status": "indexing", "pending_chunks": 231 },
            { "name": "人力资源库", "doc_count": 328, "status": "warning", "failed_docs": 2 },
        ],
        "alerts": [
            { "message": "6 个文档解析失败", "action": "查看文档" },
            { "message": "“产品定价政策” 负反馈 3 次", "action": "查看日志" },
            { "message": "向量化模型版本变更后 2 个知识库待重建索引", "action": "开始重建" },
        ]
    })))
}

async fn list_knowledge_bases(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<KnowledgeBaseSummary>>, crate::error::AppError> {
    require_tenant_admin(&actor)?;

    if let Some(pool) = &state.db_pool {
        let rows = sqlx::query_as::<_, KnowledgeBaseSummaryRow>(
            "SELECT kb.id, kb.tenant_id, kb.name, kb.description, kb.status, kb.tags,
                    0::bigint as doc_count,
                    0::bigint as chunk_count,
                    0::bigint as query_count,
                    kb.updated_at
             FROM knowledge_base kb
             WHERE kb.tenant_id = $1
             ORDER BY kb.updated_at DESC",
        )
        .bind(actor.tenant_id)
        .fetch_all(pool)
        .await?;
        return Ok(Json(rows.into_iter().map(|r| r.into()).collect()));
    }

    Ok(Json(vec![
        KnowledgeBaseSummary {
            id: state
                .config
                .default_kb_ids
                .get(0)
                .copied()
                .unwrap_or_else(|| Uuid::nil()),
            tenant_id: actor.tenant_id,
            name: "产品文档库".to_string(),
            description: Some("面向全公司的产品手册与白皮书集合".to_string()),
            status: "active".to_string(),
            tags: vec!["产品".to_string()],
            doc_count: 3201,
            chunk_count: 4832,
            query_count: 1204,
            updated_at: chrono::Utc::now(),
        },
        KnowledgeBaseSummary {
            id: Uuid::new_v4(),
            tenant_id: actor.tenant_id,
            name: "销售资料库".to_string(),
            description: Some("销售策略、报价单与合同模板".to_string()),
            status: "active".to_string(),
            tags: vec!["销售".to_string()],
            doc_count: 1044,
            chunk_count: 2156,
            query_count: 540,
            updated_at: chrono::Utc::now(),
        },
        KnowledgeBaseSummary {
            id: Uuid::new_v4(),
            tenant_id: actor.tenant_id,
            name: "人力资源库".to_string(),
            description: Some("员工手册、报销政策与规章制度".to_string()),
            status: "active".to_string(),
            tags: vec!["人事".to_string()],
            doc_count: 328,
            chunk_count: 890,
            query_count: 231,
            updated_at: chrono::Utc::now(),
        },
    ]))
}

async fn list_documents(
    ActorExtractor(actor): ActorExtractor,
) -> Result<impl IntoResponse, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    Ok(Json(json!([
        { "name": "2025年度销售策略.pptx", "type": "PPTX", "size": "2.4 MB", "chunks": 47, "status": "已完成", "updated": "2025-06-10" },
        { "name": "Q3 采购合同模板.docx", "type": "DOCX", "size": "856 KB", "chunks": 12, "status": "已完成", "updated": "2025-06-09" },
        { "name": "员工报销政策 2025.pdf", "type": "PDF", "size": "1.2 MB", "chunks": 28, "status": "已完成", "updated": "2025-06-08" },
        { "name": "产品安全规范 v2.1.pptx", "type": "PPTX", "size": "3.1 MB", "chunks": 0, "status": "解析中", "updated": "2025-06-08" },
    ])))
}

async fn list_members(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<MemberSummary>>, crate::error::AppError> {
    require_tenant_admin(&actor)?;

    if let Some(pool) = &state.db_pool {
        let rows = sqlx::query_as::<_, MemberSummaryRow>(
            "SELECT u.id, u.email, u.name, tm.roles, u.status,
                    0::bigint as query_count
             FROM app_user u
             JOIN tenant_member tm ON tm.user_id = u.id
             WHERE tm.tenant_id = $1",
        )
        .bind(actor.tenant_id)
        .fetch_all(pool)
        .await?;

        let mut members = Vec::with_capacity(rows.len());
        for row in rows {
            let allowed_kb_names: Vec<String> = sqlx::query_scalar(
                "SELECT DISTINCT kb.name FROM knowledge_base_acl acl JOIN knowledge_base kb ON kb.id = acl.kb_id WHERE acl.tenant_id = $1 AND (acl.subject_type = 'role' AND acl.subject_id = ANY($2) OR acl.subject_type = 'user' AND acl.subject_id = $3)"
            )
            .bind(actor.tenant_id)
            .bind(&row.roles)
            .bind(row.id.to_string())
            .fetch_all(pool)
            .await
            .unwrap_or_default();
            members.push(MemberSummary {
                id: row.id,
                email: row.email,
                name: row.name,
                roles: row.roles,
                allowed_kb_names,
                query_count: row.query_count,
                status: row.status,
            });
        }
        return Ok(Json(members));
    }

    Ok(Json(vec![
        MemberSummary {
            id: Uuid::new_v4(),
            email: "admin@documind.local".to_string(),
            name: Some("企业管理员".to_string()),
            roles: vec!["enterprise_admin".to_string()],
            allowed_kb_names: vec!["全部".to_string()],
            query_count: 156,
            status: "active".to_string(),
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "user@documind.local".to_string(),
            name: Some("普通用户".to_string()),
            roles: vec!["user".to_string()],
            allowed_kb_names: vec!["产品文档库".to_string(), "销售资料库".to_string()],
            query_count: 89,
            status: "active".to_string(),
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "viewer@documind.local".to_string(),
            name: Some("只读用户".to_string()),
            roles: vec!["viewer".to_string()],
            allowed_kb_names: vec!["人力资源库".to_string()],
            query_count: 34,
            status: "active".to_string(),
        },
    ]))
}

async fn list_logs(
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<QaLogSummary>>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    Ok(Json(vec![
        QaLogSummary {
            id: Uuid::new_v4(),
            question: "Q3 华东区的销售目标是多少？".to_string(),
            kb_name: "产品文档库".to_string(),
            user_name: "张三".to_string(),
            score: 0.92,
            feedback: Some("up".to_string()),
            created_at: chrono::Utc::now(),
        },
        QaLogSummary {
            id: Uuid::new_v4(),
            question: "采购合同中的违约责任怎么定义？".to_string(),
            kb_name: "销售资料库".to_string(),
            user_name: "李四".to_string(),
            score: 0.88,
            feedback: Some("up".to_string()),
            created_at: chrono::Utc::now(),
        },
        QaLogSummary {
            id: Uuid::new_v4(),
            question: "员工报销需要哪些材料？".to_string(),
            kb_name: "人力资源库".to_string(),
            user_name: "王五".to_string(),
            score: 0.76,
            feedback: Some("down".to_string()),
            created_at: chrono::Utc::now(),
        },
    ]))
}

#[derive(sqlx::FromRow)]
struct KnowledgeBaseSummaryRow {
    id: Uuid,
    tenant_id: Uuid,
    name: String,
    description: Option<String>,
    status: String,
    tags: Vec<String>,
    doc_count: i64,
    chunk_count: i64,
    query_count: i64,
    updated_at: chrono::DateTime<chrono::Utc>,
}

impl From<KnowledgeBaseSummaryRow> for KnowledgeBaseSummary {
    fn from(r: KnowledgeBaseSummaryRow) -> Self {
        Self {
            id: r.id,
            tenant_id: r.tenant_id,
            name: r.name,
            description: r.description,
            status: r.status,
            tags: r.tags,
            doc_count: r.doc_count,
            chunk_count: r.chunk_count,
            query_count: r.query_count,
            updated_at: r.updated_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct MemberSummaryRow {
    id: Uuid,
    email: String,
    name: Option<String>,
    roles: Vec<String>,
    status: String,
    query_count: i64,
}
