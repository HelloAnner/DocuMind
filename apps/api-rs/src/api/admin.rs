use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{require_tenant_admin, ActorExtractor};
use crate::models::identity::{KnowledgeBaseSummary, MemberSummary, QaLogSummary};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/overview", get(overview))
        .route(
            "/api/admin/knowledge-bases",
            get(list_knowledge_bases).post(create_knowledge_base),
        )
        .route(
            "/api/admin/knowledge-bases/:kb_id",
            put(update_knowledge_base).delete(delete_knowledge_base),
        )
        .route("/api/admin/documents", get(list_documents))
        .route("/api/admin/members", get(list_members))
        .route("/api/admin/logs", get(list_logs))
}

#[derive(Debug, Deserialize)]
struct KnowledgeBaseUpsert {
    name: String,
    description: Option<String>,
    status: Option<String>,
    tags: Option<Vec<String>>,
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
                    COUNT(DISTINCT d.id)::bigint as doc_count,
                    COUNT(c.id)::bigint as chunk_count,
                    0::bigint as query_count,
                    kb.updated_at
             FROM knowledge_base kb
             LEFT JOIN documents d
                    ON d.kb_id = kb.id
                   AND d.tenant_id = kb.tenant_id
                   AND d.parse_status <> 'deleted'
             LEFT JOIN chunks c
                    ON c.doc_id = d.id
                   AND d.latest_parse_job_id = c.parse_job_id
             WHERE kb.tenant_id = $1
             GROUP BY kb.id
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
                .first()
                .copied()
                .unwrap_or_else(Uuid::nil),
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

async fn create_knowledge_base(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(req): Json<KnowledgeBaseUpsert>,
) -> Result<Json<KnowledgeBaseSummary>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| crate::error::AppError::bad_request("KB_REQUIRES_POSTGRES", "知识库管理需要启用 PostgreSQL"))?;
    let name = normalize_kb_name(&req.name)?;
    let status = normalize_kb_status(req.status.as_deref())?;
    let tags = normalize_tags(req.tags.unwrap_or_default());

    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, KnowledgeBaseSummaryRow>(
        r#"
        INSERT INTO knowledge_base (tenant_id, name, description, status, tags, created_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        RETURNING id, tenant_id, name, description, status, tags,
                  0::bigint as doc_count, 0::bigint as chunk_count, 0::bigint as query_count,
                  updated_at
        "#,
    )
    .bind(actor.tenant_id)
    .bind(name)
    .bind(req.description.filter(|v| !v.trim().is_empty()))
    .bind(status)
    .bind(&tags)
    .bind(actor.user_id)
    .fetch_one(&mut *tx)
    .await?;

    for role in &actor.roles {
        sqlx::query(
            r#"
            INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
            VALUES ($1, $2, 'role', $3, 'manage', $4)
            ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING
            "#,
        )
        .bind(actor.tenant_id)
        .bind(row.id)
        .bind(role)
        .bind(actor.user_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(Json(row.into()))
}

async fn list_documents(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<impl IntoResponse, crate::error::AppError> {
    require_tenant_admin(&actor)?;

    if let Some(pool) = &state.db_pool {
        let rows = sqlx::query(
            "SELECT d.id, d.kb_id, d.title, d.file_type, d.file_size_bytes, d.chunk_count,
                    d.parse_status, d.parse_version, d.latest_parse_job_id, d.updated_at,
                    COUNT(c.id)::bigint AS actual_chunk_count
             FROM documents d
             LEFT JOIN chunks c
                    ON c.doc_id = d.id
                   AND d.latest_parse_job_id = c.parse_job_id
             WHERE d.tenant_id = $1
             GROUP BY d.id
             ORDER BY d.updated_at DESC",
        )
        .bind(actor.tenant_id)
        .fetch_all(pool)
        .await?;

        let docs = rows
            .into_iter()
            .map(|row| {
                let file_type: String = row.get("file_type");
                let status: String = row.get("parse_status");
                let updated_at: chrono::DateTime<chrono::Utc> = row.get("updated_at");
                let chunk_count: i64 = row.get("actual_chunk_count");
                json!({
                    "id": row.get::<Uuid, _>("id"),
                    "kb_id": row.get::<Uuid, _>("kb_id"),
                    "name": row.get::<String, _>("title"),
                    "type": file_type.to_uppercase(),
                    "size": format_file_size(row.get("file_size_bytes")),
                    "chunks": chunk_count,
                    "status": format_parse_status(&status),
                    "parse_status": status,
                    "parse_version": row.get::<i32, _>("parse_version"),
                    "latest_parse_job_id": row.get::<Option<Uuid>, _>("latest_parse_job_id"),
                    "updated": updated_at.format("%Y-%m-%d").to_string(),
                })
            })
            .collect::<Vec<_>>();
        return Ok(Json(json!(docs)));
    }

    Ok(Json(json!([
        { "name": "2025年度销售策略.pptx", "type": "PPTX", "size": "2.4 MB", "chunks": 47, "status": "已完成", "updated": "2025-06-10" },
        { "name": "Q3 采购合同模板.docx", "type": "DOCX", "size": "856 KB", "chunks": 12, "status": "已完成", "updated": "2025-06-09" },
        { "name": "员工报销政策 2025.pdf", "type": "PDF", "size": "1.2 MB", "chunks": 28, "status": "已完成", "updated": "2025-06-08" },
        { "name": "产品安全规范 v2.1.pptx", "type": "PPTX", "size": "3.1 MB", "chunks": 0, "status": "解析中", "updated": "2025-06-08" },
    ])))
}

fn format_parse_status(status: &str) -> &'static str {
    match status {
        "indexed" => "已完成",
        "parsing" | "uploaded" => "解析中",
        "parse_failed" => "失败",
        "parse_low_confidence" => "低置信",
        _ => "未知",
    }
}

fn format_file_size(bytes: i64) -> String {
    let bytes = bytes.max(0) as f64;
    if bytes >= 1024.0 * 1024.0 {
        format!("{:.1} MB", bytes / 1024.0 / 1024.0)
    } else if bytes >= 1024.0 {
        format!("{:.0} KB", bytes / 1024.0)
    } else {
        format!("{} B", bytes as i64)
    }
}

async fn update_knowledge_base(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(kb_id): Path<Uuid>,
    Json(req): Json<KnowledgeBaseUpsert>,
) -> Result<Json<KnowledgeBaseSummary>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| crate::error::AppError::bad_request("KB_REQUIRES_POSTGRES", "知识库管理需要启用 PostgreSQL"))?;
    let name = normalize_kb_name(&req.name)?;
    let status = normalize_kb_status(req.status.as_deref())?;
    let tags = normalize_tags(req.tags.unwrap_or_default());

    let row = sqlx::query_as::<_, KnowledgeBaseSummaryRow>(
        r#"
        WITH updated AS (
            UPDATE knowledge_base
            SET name = $3, description = $4, status = $5, tags = $6, updated_at = now()
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, tenant_id, name, description, status, tags, updated_at
        )
        SELECT kb.id, kb.tenant_id, kb.name, kb.description, kb.status, kb.tags,
               COALESCE(ds.doc_count, 0)::bigint as doc_count,
               COALESCE(ds.chunk_count, 0)::bigint as chunk_count,
               0::bigint as query_count,
               kb.updated_at
        FROM updated kb
        LEFT JOIN (
            SELECT kb_id, COUNT(*)::bigint AS doc_count, COALESCE(SUM(chunk_count), 0)::bigint AS chunk_count
            FROM documents
            WHERE tenant_id = $1 AND kb_id = $2
            GROUP BY kb_id
        ) ds ON ds.kb_id = kb.id
        "#,
    )
    .bind(actor.tenant_id)
    .bind(kb_id)
    .bind(name)
    .bind(req.description.filter(|v| !v.trim().is_empty()))
    .bind(status)
    .bind(&tags)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::error::AppError::NotFound {
        code: "KB_NOT_FOUND".to_string(),
        message: "知识库不存在或无权限".to_string(),
    })?;

    Ok(Json(row.into()))
}

async fn delete_knowledge_base(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(kb_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| crate::error::AppError::bad_request("KB_REQUIRES_POSTGRES", "知识库管理需要启用 PostgreSQL"))?;
    let result = sqlx::query("DELETE FROM knowledge_base WHERE tenant_id = $1 AND id = $2")
        .bind(actor.tenant_id)
        .bind(kb_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(crate::error::AppError::NotFound {
            code: "KB_NOT_FOUND".to_string(),
            message: "知识库不存在或无权限".to_string(),
        });
    }
    Ok(Json(json!({ "kb_id": kb_id, "status": "deleted" })))
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
        MemberSummary {
            id: Uuid::new_v4(),
            email: "zhangsan@company.com".to_string(),
            name: Some("张三".to_string()),
            roles: vec!["tenant_admin".to_string()],
            allowed_kb_names: vec!["全部".to_string()],
            query_count: 156,
            status: "active".to_string(),
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "lisi@company.com".to_string(),
            name: Some("李四".to_string()),
            roles: vec!["end_user".to_string()],
            allowed_kb_names: vec!["产品文档库".to_string(), "销售资料库".to_string()],
            query_count: 89,
            status: "active".to_string(),
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "wangwu@company.com".to_string(),
            name: Some("王五".to_string()),
            roles: vec!["end_user".to_string()],
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

fn normalize_kb_name(value: &str) -> Result<String, crate::error::AppError> {
    let name = value.trim();
    if name.is_empty() {
        return Err(crate::error::AppError::bad_request("KB_NAME_EMPTY", "知识库名称不能为空"));
    }
    if name.chars().count() > 128 {
        return Err(crate::error::AppError::bad_request("KB_NAME_TOO_LONG", "知识库名称不能超过 128 个字符"));
    }
    Ok(name.to_string())
}

fn normalize_kb_status(value: Option<&str>) -> Result<&str, crate::error::AppError> {
    let status = value.unwrap_or("active").trim();
    match status {
        "active" | "disabled" | "archived" => Ok(status),
        _ => Err(crate::error::AppError::bad_request("KB_STATUS_INVALID", "知识库状态只能是 active / disabled / archived")),
    }
}

fn normalize_tags(values: Vec<String>) -> Vec<String> {
    let mut tags = values
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .take(20)
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    tags
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
