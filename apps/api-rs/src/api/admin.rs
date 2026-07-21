use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{record_audit_event, require_permission, require_tenant_admin, ActorExtractor};
use crate::models::identity::{KnowledgeBaseSummary, MemberSummary, QaLogSummary};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/overview", get(overview))
        .route("/api/admin/runtime-config", get(runtime_config))
        .route(
            "/api/admin/knowledge-bases",
            get(list_knowledge_bases).post(create_knowledge_base),
        )
        .route(
            "/api/admin/knowledge-bases/:kb_id",
            put(update_knowledge_base).delete(delete_knowledge_base),
        )
        .route("/api/admin/members", get(list_members))
        .route(
            "/api/admin/invitations",
            get(list_invitations).post(create_invitation),
        )
        .route(
            "/api/admin/invitations/:invitation_id/resend",
            axum::routing::post(resend_invitation),
        )
        .route(
            "/api/admin/invitations/:invitation_id/revoke",
            axum::routing::post(revoke_invitation),
        )
        .route(
            "/api/admin/permissions",
            get(list_permissions).post(grant_permission),
        )
        .route("/api/admin/permissions/:acl_id", delete(revoke_permission))
        .route("/api/admin/logs", get(list_logs))
}

#[derive(Debug, Deserialize)]
struct KnowledgeBaseUpsert {
    name: String,
    description: Option<String>,
    status: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct PermissionGrantRequest {
    kb_id: Uuid,
    subject_type: String,
    subject_id: String,
    permission: String,
}

#[derive(Debug, Deserialize)]
struct InvitationGrantRequest {
    kb_id: Uuid,
    permission: String,
}

#[derive(Debug, Deserialize)]
struct InvitationCreateRequest {
    email: String,
    name: Option<String>,
    roles: Vec<String>,
    kb_grants: Option<Vec<InvitationGrantRequest>>,
    expires_in_days: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AdminLogQuery {
    range: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct KnowledgeBaseAuthorization {
    id: Uuid,
    tenant_id: Uuid,
    kb_id: Uuid,
    kb_name: String,
    subject_type: String,
    subject_id: String,
    subject_label: String,
    permission: String,
    created_by: Option<Uuid>,
    created_by_label: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
struct TenantInvitationSummary {
    id: Uuid,
    tenant_id: Uuid,
    email: String,
    name: Option<String>,
    roles: Vec<String>,
    kb_grants: serde_json::Value,
    status: String,
    invited_by: Uuid,
    invited_by_label: Option<String>,
    accepted_by: Option<Uuid>,
    expires_at: chrono::DateTime<chrono::Utc>,
    accepted_at: Option<chrono::DateTime<chrono::Utc>>,
    revoked_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: chrono::DateTime<chrono::Utc>,
    invite_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct InvitationGrant {
    kb_id: Uuid,
    permission: String,
}

async fn overview(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<impl IntoResponse, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    if let Some(pool) = &state.db_pool {
        let row = sqlx::query(
            "SELECT
                (SELECT COUNT(*) FROM documents WHERE tenant_id = $1) AS doc_count,
                (SELECT COUNT(*) FROM documents WHERE tenant_id = $1 AND parse_status = 'indexed') AS indexed_doc_count,
                (SELECT COALESCE(SUM(chunk_count), 0) FROM documents WHERE tenant_id = $1) AS chunk_count,
                (SELECT COUNT(*) FROM tenant_member WHERE tenant_id = $1 AND status = 'active') AS active_users,
                (SELECT COUNT(*) FROM documents WHERE tenant_id = $1 AND parse_status IN ('parse_failed', 'parse_low_confidence', 'ocr_pending', 'embedding_failed', 'parsing', 'parsed')) AS failed_docs,
                (SELECT COUNT(*)
                   FROM document_parse_jobs j
                   JOIN documents d ON d.id = j.doc_id
                  WHERE j.tenant_id = $1
                    AND j.status IN ('pending', 'running')
                    AND d.parse_status NOT IN ('indexed', 'parse_low_confidence', 'ocr_pending')) AS running_jobs",
        )
        .bind(actor.tenant_id)
        .fetch_one(pool)
        .await?;

        let kbs = sqlx::query(
            "SELECT kb.name,
                    kb.status,
                    COUNT(DISTINCT d.id)::bigint AS doc_count,
                    COALESCE(SUM(d.chunk_count), 0)::bigint AS chunk_count
             FROM knowledge_base kb
             LEFT JOIN documents d ON d.kb_id = kb.id AND d.tenant_id = kb.tenant_id
             WHERE kb.tenant_id = $1
             GROUP BY kb.id
             ORDER BY kb.updated_at DESC
             LIMIT 8",
        )
        .bind(actor.tenant_id)
        .fetch_all(pool)
        .await?;

        return Ok(Json(json!({
            "doc_count": row.get::<i64, _>("doc_count"),
            "indexed_doc_count": row.get::<i64, _>("indexed_doc_count"),
            "chunk_count": row.get::<i64, _>("chunk_count"),
            "active_users": row.get::<i64, _>("active_users"),
            "failed_docs": row.get::<i64, _>("failed_docs"),
            "running_jobs": row.get::<i64, _>("running_jobs"),
            "knowledge_bases": kbs.into_iter().map(|kb| json!({
                "name": kb.get::<String, _>("name"),
                "doc_count": kb.get::<i64, _>("doc_count"),
                "chunk_count": kb.get::<i64, _>("chunk_count"),
                "status": kb.get::<String, _>("status")
            })).collect::<Vec<_>>(),
            "alerts": []
        })));
    }

    Ok(Json(json!({
        "doc_count": 0,
        "indexed_doc_count": 0,
        "chunk_count": 0,
        "active_users": 0,
        "failed_docs": 0,
        "running_jobs": 0,
        "knowledge_bases": [],
        "alerts": []
    })))
}

async fn runtime_config(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "config.read")?;

    let cfg = &state.config;
    let chunk_cfg = crate::document::ChunkConfig::default();
    let llm_provider = provider_name(&cfg.rag.generation.base_url);
    Ok(Json(json!({
        "read_only": true,
        "source": "server_env",
        "environment": cfg.environment.as_str(),
        "chunking": {
            "strategy": "structure_aware",
            "chunker_version": crate::document::CHUNKER_VERSION,
            "target_chunk_tokens": chunk_cfg.target_chunk_tokens,
            "max_chunk_tokens": chunk_cfg.max_chunk_tokens,
            "hard_split_tokens": chunk_cfg.hard_split_tokens,
            "min_chunk_tokens": chunk_cfg.min_chunk_tokens,
            "overlap_tokens": chunk_cfg.overlap_tokens,
            "max_table_rows_per_chunk": chunk_cfg.max_table_rows_per_chunk,
            "max_table_token_per_chunk": chunk_cfg.max_table_token_per_chunk,
            "preserve_table_structure": true,
            "preserve_list_hierarchy": true,
            "merge_short_blocks": true
        },
        "embedding": {
            "enabled": cfg.rag.embedding.enabled,
            "model": cfg.rag.embedding.model,
            "base_url": cfg.rag.embedding.base_url,
            "api_key_configured": cfg.rag.embedding.api_key.as_ref().is_some_and(|key| !key.trim().is_empty()),
            "batch_size": cfg.rag.embedding.batch_size,
            "dimension": cfg.rag.embedding.dimension,
            "retry_max": cfg.rag.embedding.retry_max,
            "worker_poll_ms": cfg.rag.embedding.worker_poll_ms,
            "index_name": cfg.rag.embedding.index_name,
            "index_alias": cfg.rag.embedding.index_alias,
            "index_schema_version": cfg.rag.embedding.index_schema_version,
            "queue": "documind.embedding.pending",
            "dead_letter_queue": "documind.embedding.dead",
            "canonical_vector_store": "postgresql.chunk_embeddings.embedding_values",
            "retrieval_store": "elasticsearch"
        },
        "search": {
            "strategy": "Dense + BM25 + RRF",
            "dense_top_k": cfg.rag.retrieval.dense_top_k,
            "bm25_top_k": cfg.rag.retrieval.bm25_top_k,
            "rrf_top_k": cfg.rag.retrieval.rrf_top_k,
            "effective_top_k": cfg.rag.retrieval.effective_top_k,
            "rerank_enabled": cfg.rag.rerank.enabled,
            "rerank_model": cfg.rag.rerank.model,
            "rerank_api_configured": cfg.rag.rerank.api_url.as_ref().is_some_and(|url| !url.trim().is_empty()),
            "rerank_min_score": cfg.rag.rerank.min_score
        },
        "llm": {
            "provider": llm_provider,
            "use_real_llm": cfg.rag.generation.use_real_llm,
            "model": cfg.rag.generation.model,
            "base_url": cfg.rag.generation.base_url,
            "api_key_configured": !cfg.rag.generation.api_key.trim().is_empty() && cfg.rag.generation.api_key != "ollama",
            "temperature": cfg.rag.generation.temperature,
            "max_output_tokens": cfg.rag.generation.max_output_tokens,
            "streaming_enabled": cfg.rag.generation.use_real_llm,
            "rewrite_enabled": cfg.rag.rewrite.enabled,
            "rewrite_model": cfg.rag.rewrite.model
        }
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
    require_permission(&actor, "kb.create")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        crate::error::AppError::bad_request("KB_REQUIRES_POSTGRES", "知识库管理需要启用 PostgreSQL")
    })?;
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
    record_audit_event(
        &state,
        Some(&actor),
        "knowledge_base.create",
        Some("knowledge_base"),
        Some(&row.id.to_string()),
        json!({
            "name": row.name.clone(),
            "status": row.status.clone(),
            "tags": row.tags.clone(),
        }),
    )
    .await?;
    Ok(Json(row.into()))
}

async fn update_knowledge_base(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(kb_id): Path<Uuid>,
    Json(req): Json<KnowledgeBaseUpsert>,
) -> Result<Json<KnowledgeBaseSummary>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        crate::error::AppError::bad_request("KB_REQUIRES_POSTGRES", "知识库管理需要启用 PostgreSQL")
    })?;
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

    record_audit_event(
        &state,
        Some(&actor),
        "knowledge_base.update",
        Some("knowledge_base"),
        Some(&row.id.to_string()),
        json!({
            "name": row.name.clone(),
            "status": row.status.clone(),
            "tags": row.tags.clone(),
        }),
    )
    .await?;
    Ok(Json(row.into()))
}

async fn delete_knowledge_base(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(kb_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        crate::error::AppError::bad_request("KB_REQUIRES_POSTGRES", "知识库管理需要启用 PostgreSQL")
    })?;
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
    record_audit_event(
        &state,
        Some(&actor),
        "knowledge_base.delete",
        Some("knowledge_base"),
        Some(&kb_id.to_string()),
        json!({}),
    )
    .await?;
    Ok(Json(json!({ "kb_id": kb_id, "status": "deleted" })))
}

async fn list_members(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<MemberSummary>>, crate::error::AppError> {
    require_tenant_admin(&actor)?;

    if let Some(pool) = &state.db_pool {
        let rows = sqlx::query_as::<_, MemberSummaryRow>(
            "SELECT u.id, u.email, u.name, tm.roles, tm.status,
                    tm.joined_at, tm.last_seen_at,
                    0::bigint as query_count
             FROM app_user u
             JOIN tenant_member tm ON tm.user_id = u.id
             LEFT JOIN platform_admin pa ON pa.user_id = u.id AND pa.status = 'active'
             WHERE tm.tenant_id = $1
               AND tm.status <> 'removed'
               AND pa.user_id IS NULL
             ORDER BY CASE WHEN 'tenant_admin' = ANY(tm.roles) THEN 0 ELSE 1 END,
                      tm.joined_at DESC NULLS LAST",
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
                joined_at: row.joined_at,
                last_seen_at: row.last_seen_at,
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
            joined_at: Some(Utc::now()),
            last_seen_at: Some(Utc::now()),
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "user@documind.local".to_string(),
            name: Some("普通用户".to_string()),
            roles: vec!["user".to_string()],
            allowed_kb_names: vec!["产品文档库".to_string(), "销售资料库".to_string()],
            query_count: 89,
            status: "active".to_string(),
            joined_at: Some(Utc::now()),
            last_seen_at: Some(Utc::now()),
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "viewer@documind.local".to_string(),
            name: Some("只读用户".to_string()),
            roles: vec!["viewer".to_string()],
            allowed_kb_names: vec!["人力资源库".to_string()],
            query_count: 34,
            status: "active".to_string(),
            joined_at: Some(Utc::now()),
            last_seen_at: None,
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "zhangsan@company.com".to_string(),
            name: Some("张三".to_string()),
            roles: vec!["tenant_admin".to_string()],
            allowed_kb_names: vec!["全部".to_string()],
            query_count: 156,
            status: "active".to_string(),
            joined_at: Some(Utc::now()),
            last_seen_at: Some(Utc::now()),
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "lisi@company.com".to_string(),
            name: Some("李四".to_string()),
            roles: vec!["end_user".to_string()],
            allowed_kb_names: vec!["产品文档库".to_string(), "销售资料库".to_string()],
            query_count: 89,
            status: "active".to_string(),
            joined_at: Some(Utc::now()),
            last_seen_at: Some(Utc::now()),
        },
        MemberSummary {
            id: Uuid::new_v4(),
            email: "wangwu@company.com".to_string(),
            name: Some("王五".to_string()),
            roles: vec!["end_user".to_string()],
            allowed_kb_names: vec!["人力资源库".to_string()],
            query_count: 34,
            status: "active".to_string(),
            joined_at: Some(Utc::now()),
            last_seen_at: None,
        },
    ]))
}

async fn list_invitations(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<TenantInvitationSummary>>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "member.read")?;

    let Some(pool) = &state.db_pool else {
        return Ok(Json(vec![]));
    };

    let rows = sqlx::query(
        r#"
        SELECT inv.id,
               inv.tenant_id,
               inv.email,
               inv.name,
               inv.roles,
               inv.kb_grants,
               CASE
                 WHEN inv.status = 'pending' AND inv.expires_at < NOW() THEN 'expired'
                 ELSE inv.status
               END AS status,
               inv.invited_by,
               COALESCE(NULLIF(u.name, ''), u.email) AS invited_by_label,
               inv.accepted_by,
               inv.expires_at,
               inv.accepted_at,
               inv.revoked_at,
               inv.created_at
        FROM tenant_invitation inv
        LEFT JOIN app_user u ON u.id = inv.invited_by
        WHERE inv.tenant_id = $1
        ORDER BY inv.created_at DESC
        LIMIT 100
        "#,
    )
    .bind(actor.tenant_id)
    .fetch_all(pool)
    .await?;

    Ok(Json(rows.into_iter().map(invitation_from_row).collect()))
}

async fn create_invitation(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(req): Json<InvitationCreateRequest>,
) -> Result<Json<TenantInvitationSummary>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "member.write")?;

    let Some(pool) = &state.db_pool else {
        return Err(crate::error::AppError::bad_request(
            "DB_REQUIRED",
            "邀请功能需要数据库",
        ));
    };

    let email = normalize_email(&req.email)?;
    let roles = normalize_invitation_roles(&req.roles)?;
    let grants =
        normalize_invitation_grants(pool, actor.tenant_id, req.kb_grants.unwrap_or_default())
            .await?;
    let expires_at = Utc::now() + Duration::days(req.expires_in_days.unwrap_or(7).clamp(1, 30));
    let token = new_invitation_token();
    let token_hash = invitation_token_hash(&token);
    let grants_json = serde_json::to_value(&grants)?;

    let row = sqlx::query(
        r#"
        INSERT INTO tenant_invitation
          (tenant_id, email, name, roles, kb_grants, token_hash, status, invited_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
        ON CONFLICT DO NOTHING
        RETURNING id,
                  tenant_id,
                  email,
                  name,
                  roles,
                  kb_grants,
                  status,
                  invited_by,
                  NULL::text AS invited_by_label,
                  accepted_by,
                  expires_at,
                  accepted_at,
                  revoked_at,
                  created_at
        "#,
    )
    .bind(actor.tenant_id)
    .bind(&email)
    .bind(req.name.as_deref().map(str::trim).filter(|v| !v.is_empty()))
    .bind(&roles)
    .bind(&grants_json)
    .bind(&token_hash)
    .bind(actor.user_id)
    .bind(expires_at)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::error::AppError::Conflict {
        code: "INVITATION_EXISTS".to_string(),
        message: "该邮箱已有待接受邀请".to_string(),
    })?;

    let mut invitation = invitation_from_row(row);
    invitation.invite_url = Some(invite_url(&token));
    record_audit_event(
        &state,
        Some(&actor),
        "tenant_invitation.create",
        Some("tenant_invitation"),
        Some(&invitation.id.to_string()),
        json!({
            "email": invitation.email,
            "roles": invitation.roles,
            "kb_grants": invitation.kb_grants,
            "expires_at": invitation.expires_at,
        }),
    )
    .await?;
    Ok(Json(invitation))
}

async fn resend_invitation(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(invitation_id): Path<Uuid>,
) -> Result<Json<TenantInvitationSummary>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "member.write")?;
    let Some(pool) = &state.db_pool else {
        return Err(crate::error::AppError::bad_request(
            "DB_REQUIRED",
            "邀请功能需要数据库",
        ));
    };

    let token = new_invitation_token();
    let token_hash = invitation_token_hash(&token);
    let expires_at = Utc::now() + Duration::days(7);
    let row = sqlx::query(
        r#"
        UPDATE tenant_invitation
        SET token_hash = $3,
            expires_at = $4,
            status = 'pending',
            revoked_at = NULL,
            updated_at = NOW()
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'pending'
          AND accepted_at IS NULL
        RETURNING id,
                  tenant_id,
                  email,
                  name,
                  roles,
                  kb_grants,
                  status,
                  invited_by,
                  NULL::text AS invited_by_label,
                  accepted_by,
                  expires_at,
                  accepted_at,
                  revoked_at,
                  created_at
        "#,
    )
    .bind(actor.tenant_id)
    .bind(invitation_id)
    .bind(&token_hash)
    .bind(expires_at)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::error::AppError::NotFound {
        code: "INVITATION_NOT_FOUND".to_string(),
        message: "邀请不存在、已接受或已撤销".to_string(),
    })?;

    let mut invitation = invitation_from_row(row);
    invitation.invite_url = Some(invite_url(&token));
    record_audit_event(
        &state,
        Some(&actor),
        "tenant_invitation.resend",
        Some("tenant_invitation"),
        Some(&invitation.id.to_string()),
        json!({ "email": invitation.email, "expires_at": invitation.expires_at }),
    )
    .await?;
    Ok(Json(invitation))
}

async fn revoke_invitation(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(invitation_id): Path<Uuid>,
) -> Result<Json<TenantInvitationSummary>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "member.write")?;
    let Some(pool) = &state.db_pool else {
        return Err(crate::error::AppError::bad_request(
            "DB_REQUIRED",
            "邀请功能需要数据库",
        ));
    };

    let row = sqlx::query(
        r#"
        UPDATE tenant_invitation
        SET status = 'revoked',
            revoked_at = NOW(),
            updated_at = NOW()
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'pending'
          AND accepted_at IS NULL
        RETURNING id,
                  tenant_id,
                  email,
                  name,
                  roles,
                  kb_grants,
                  status,
                  invited_by,
                  NULL::text AS invited_by_label,
                  accepted_by,
                  expires_at,
                  accepted_at,
                  revoked_at,
                  created_at
        "#,
    )
    .bind(actor.tenant_id)
    .bind(invitation_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::error::AppError::NotFound {
        code: "INVITATION_NOT_FOUND".to_string(),
        message: "邀请不存在、已接受或已撤销".to_string(),
    })?;

    let invitation = invitation_from_row(row);
    record_audit_event(
        &state,
        Some(&actor),
        "tenant_invitation.revoke",
        Some("tenant_invitation"),
        Some(&invitation.id.to_string()),
        json!({ "email": invitation.email }),
    )
    .await?;
    Ok(Json(invitation))
}

async fn list_permissions(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<KnowledgeBaseAuthorization>>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "kb.manage")?;

    let Some(pool) = &state.db_pool else {
        return Ok(Json(vec![]));
    };

    let rows = sqlx::query(
        r#"
        SELECT acl.id,
               acl.tenant_id,
               acl.kb_id,
               kb.name AS kb_name,
               acl.subject_type,
               acl.subject_id,
               acl.permission,
               acl.created_by,
               COALESCE(NULLIF(u.name, ''), u.email) AS user_label,
               COALESCE(NULLIF(c.name, ''), c.email) AS created_by_label,
               acl.created_at
        FROM knowledge_base_acl acl
        JOIN knowledge_base kb
          ON kb.tenant_id = acl.tenant_id
         AND kb.id = acl.kb_id
        LEFT JOIN app_user u
          ON acl.subject_type = 'user'
         AND u.id::text = acl.subject_id
        LEFT JOIN app_user c
          ON c.id = acl.created_by
        WHERE acl.tenant_id = $1
        ORDER BY kb.name ASC,
                 acl.subject_type ASC,
                 acl.subject_id ASC,
                 CASE acl.permission
                   WHEN 'manage' THEN 0
                   WHEN 'write' THEN 1
                   ELSE 2
                 END
        "#,
    )
    .bind(actor.tenant_id)
    .fetch_all(pool)
    .await?;

    Ok(Json(rows.into_iter().map(permission_from_row).collect()))
}

async fn grant_permission(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(req): Json<PermissionGrantRequest>,
) -> Result<Json<KnowledgeBaseAuthorization>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "kb.manage")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        crate::error::AppError::bad_request(
            "ACL_REQUIRES_POSTGRES",
            "知识库授权需要启用 PostgreSQL",
        )
    })?;

    let subject_type = normalize_acl_subject_type(&req.subject_type)?;
    let permission = normalize_acl_permission(&req.permission)?;
    ensure_kb_exists(pool, actor.tenant_id, req.kb_id).await?;
    let subject_id =
        normalize_acl_subject_id(pool, actor.tenant_id, subject_type, &req.subject_id).await?;

    let acl_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission)
        DO UPDATE SET created_by = knowledge_base_acl.created_by
        RETURNING id
        "#,
    )
    .bind(actor.tenant_id)
    .bind(req.kb_id)
    .bind(subject_type)
    .bind(&subject_id)
    .bind(permission)
    .bind(actor.user_id)
    .fetch_one(pool)
    .await?;

    let row = fetch_permission(pool, actor.tenant_id, acl_id).await?;
    record_audit_event(
        &state,
        Some(&actor),
        "knowledge_base_acl.grant",
        Some("knowledge_base_acl"),
        Some(&acl_id.to_string()),
        json!({
            "kb_id": row.kb_id,
            "kb_name": row.kb_name,
            "subject_type": row.subject_type,
            "subject_id": row.subject_id,
            "permission": row.permission,
        }),
    )
    .await?;
    Ok(Json(row))
}

async fn revoke_permission(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(acl_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "kb.manage")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        crate::error::AppError::bad_request(
            "ACL_REQUIRES_POSTGRES",
            "知识库授权需要启用 PostgreSQL",
        )
    })?;

    let existing = fetch_permission(pool, actor.tenant_id, acl_id).await?;
    let result = sqlx::query("DELETE FROM knowledge_base_acl WHERE tenant_id = $1 AND id = $2")
        .bind(actor.tenant_id)
        .bind(acl_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(crate::error::AppError::NotFound {
            code: "ACL_NOT_FOUND".to_string(),
            message: "授权记录不存在或无权限".to_string(),
        });
    }

    record_audit_event(
        &state,
        Some(&actor),
        "knowledge_base_acl.revoke",
        Some("knowledge_base_acl"),
        Some(&acl_id.to_string()),
        json!({
            "kb_id": existing.kb_id,
            "kb_name": existing.kb_name,
            "subject_type": existing.subject_type,
            "subject_id": existing.subject_id,
            "permission": existing.permission,
        }),
    )
    .await?;
    Ok(Json(json!({ "id": acl_id, "status": "revoked" })))
}

async fn list_logs(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Query(query): Query<AdminLogQuery>,
) -> Result<Json<Vec<QaLogSummary>>, crate::error::AppError> {
    require_tenant_admin(&actor)?;
    let Some(pool) = &state.db_pool else {
        return Ok(Json(vec![]));
    };
    let range = normalize_log_range(query.range.as_deref());
    let q = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{value}%"));
    let limit = query.limit.unwrap_or(100).clamp(1, 200);

    let rows = sqlx::query(
        "SELECT a.id,
                COALESCE(u.content, '') AS question,
                COALESCE(
                    NULLIF(string_agg(DISTINCT kb.name, ', '), ''),
                    '未关联知识库'
                ) AS kb_name,
                COALESCE(au.name, au.email, '未知用户') AS user_name,
                CASE a.confidence
                    WHEN 'high' THEN 0.95
                    WHEN 'medium' THEN 0.75
                    WHEN 'low' THEN 0.55
                    ELSE 0.50
                END::double precision AS score,
                f.rating AS feedback,
                a.created_at
         FROM conversation_messages a
         LEFT JOIN conversation_messages u ON u.id = a.parent_message_id
         LEFT JOIN app_user au ON au.id = a.user_id
         LEFT JOIN conversation_feedback f ON f.assistant_message_id = a.id
         LEFT JOIN conversation_sessions s ON s.id = a.conversation_id
         LEFT JOIN knowledge_base kb
                ON kb.tenant_id = a.tenant_id
               AND kb.id = ANY(s.kb_ids)
         WHERE a.tenant_id = $1
           AND a.role = 'assistant'
           AND a.status = 'completed'
           AND (
                $2 = 'all'
                OR ($2 = 'today' AND a.created_at >= date_trunc('day', now()))
                OR ($2 = 'week' AND a.created_at >= now() - interval '7 days')
                OR ($2 = 'month' AND a.created_at >= now() - interval '30 days')
           )
           AND (
                $3::text IS NULL
                OR COALESCE(u.content, '') ILIKE $3
                OR COALESCE(au.name, '') ILIKE $3
                OR COALESCE(au.email, '') ILIKE $3
                OR COALESCE(kb.name, '') ILIKE $3
           )
         GROUP BY a.id, u.content, au.name, au.email, f.rating, a.confidence, a.created_at
         ORDER BY a.created_at DESC
         LIMIT $4",
    )
    .bind(actor.tenant_id)
    .bind(range)
    .bind(q)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| QaLogSummary {
                id: row.get("id"),
                question: row.get("question"),
                kb_name: row.get("kb_name"),
                user_name: row.get("user_name"),
                score: row.get("score"),
                feedback: row.get("feedback"),
                created_at: row.get("created_at"),
            })
            .collect(),
    ))
}

fn normalize_log_range(value: Option<&str>) -> &'static str {
    match value.unwrap_or("today") {
        "today" => "today",
        "week" => "week",
        "month" => "month",
        "all" => "all",
        _ => "today",
    }
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
        return Err(crate::error::AppError::bad_request(
            "KB_NAME_EMPTY",
            "知识库名称不能为空",
        ));
    }
    if name.chars().count() > 128 {
        return Err(crate::error::AppError::bad_request(
            "KB_NAME_TOO_LONG",
            "知识库名称不能超过 128 个字符",
        ));
    }
    Ok(name.to_string())
}

fn normalize_kb_status(value: Option<&str>) -> Result<&str, crate::error::AppError> {
    let status = value.unwrap_or("active").trim();
    match status {
        "active" | "disabled" | "archived" => Ok(status),
        _ => Err(crate::error::AppError::bad_request(
            "KB_STATUS_INVALID",
            "知识库状态只能是 active / disabled / archived",
        )),
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

fn normalize_email(value: &str) -> Result<String, crate::error::AppError> {
    let email = value.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(crate::error::AppError::bad_request(
            "EMAIL_INVALID",
            "请输入有效邮箱",
        ));
    }
    Ok(email)
}

fn normalize_invitation_roles(values: &[String]) -> Result<Vec<String>, crate::error::AppError> {
    if values.is_empty() {
        return Err(crate::error::AppError::bad_request(
            "INVITATION_ROLE_REQUIRED",
            "邀请至少需要一个角色",
        ));
    }
    let mut roles = Vec::new();
    for value in values {
        let role = match value.trim() {
            "tenant_admin" => "tenant_admin",
            "end_user" | "user" | "analyst" | "viewer" => "end_user",
            "super_admin" => return Err(crate::error::AppError::forbidden()),
            _ => {
                return Err(crate::error::AppError::bad_request(
                    "INVITATION_ROLE_INVALID",
                    "可邀请角色只能是 tenant_admin / end_user",
                ));
            }
        };
        if !roles.iter().any(|item| item == role) {
            roles.push(role.to_string());
        }
    }
    Ok(roles)
}

async fn normalize_invitation_grants(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    grants: Vec<InvitationGrantRequest>,
) -> Result<Vec<InvitationGrant>, crate::error::AppError> {
    let mut out = Vec::new();
    for grant in grants {
        ensure_kb_exists(pool, tenant_id, grant.kb_id).await?;
        let permission = normalize_acl_permission(&grant.permission)?.to_string();
        if !out.iter().any(|item: &InvitationGrant| {
            item.kb_id == grant.kb_id && item.permission == permission
        }) {
            out.push(InvitationGrant {
                kb_id: grant.kb_id,
                permission,
            });
        }
    }
    Ok(out)
}

fn new_invitation_token() -> String {
    format!("inv_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn invitation_token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

fn invite_url(token: &str) -> String {
    format!("/invite?token={token}")
}

fn invitation_from_row(row: sqlx::postgres::PgRow) -> TenantInvitationSummary {
    TenantInvitationSummary {
        id: row.get("id"),
        tenant_id: row.get("tenant_id"),
        email: row.get("email"),
        name: row.try_get("name").ok(),
        roles: row.get("roles"),
        kb_grants: row
            .try_get("kb_grants")
            .unwrap_or_else(|_| serde_json::json!([])),
        status: row.get("status"),
        invited_by: row.get("invited_by"),
        invited_by_label: row.try_get("invited_by_label").ok(),
        accepted_by: row.try_get("accepted_by").ok(),
        expires_at: row.get("expires_at"),
        accepted_at: row.try_get("accepted_at").ok(),
        revoked_at: row.try_get("revoked_at").ok(),
        created_at: row.get("created_at"),
        invite_url: None,
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
    joined_at: Option<chrono::DateTime<chrono::Utc>>,
    last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
}

async fn ensure_kb_exists(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    kb_id: Uuid,
) -> Result<(), crate::error::AppError> {
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM knowledge_base WHERE tenant_id = $1 AND id = $2")
            .bind(tenant_id)
            .bind(kb_id)
            .fetch_optional(pool)
            .await?;
    if exists.is_none() {
        return Err(crate::error::AppError::NotFound {
            code: "KB_NOT_FOUND".to_string(),
            message: "知识库不存在或无权限".to_string(),
        });
    }
    Ok(())
}

async fn normalize_acl_subject_id(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    subject_type: &str,
    raw: &str,
) -> Result<String, crate::error::AppError> {
    let subject = raw.trim();
    if subject.is_empty() {
        return Err(crate::error::AppError::bad_request(
            "ACL_SUBJECT_EMPTY",
            "授权对象不能为空",
        ));
    }

    if subject_type == "role" {
        let roles = [
            "tenant_admin",
            "tenant_owner",
            "team_admin",
            "data_admin",
            "user",
            "analyst",
            "end_user",
            "viewer",
        ];
        if roles.contains(&subject) {
            return Ok(subject.to_string());
        }
        return Err(crate::error::AppError::bad_request(
            "ACL_ROLE_INVALID",
            "角色必须是 tenant_admin / team_admin / data_admin / user / analyst / end_user / viewer",
        ));
    }

    let row = if let Ok(user_id) = Uuid::parse_str(subject) {
        sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT u.id
            FROM app_user u
            JOIN tenant_member tm
              ON tm.user_id = u.id
             AND tm.tenant_id = $1
             AND tm.status = 'active'
            WHERE u.id = $2
              AND u.status = 'active'
            LIMIT 1
            "#,
        )
        .bind(tenant_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
    } else {
        sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT u.id
            FROM app_user u
            JOIN tenant_member tm
              ON tm.user_id = u.id
             AND tm.tenant_id = $1
             AND tm.status = 'active'
            WHERE lower(u.email) = lower($2)
              AND u.status = 'active'
            LIMIT 1
            "#,
        )
        .bind(tenant_id)
        .bind(subject)
        .fetch_optional(pool)
        .await?
    };

    row.map(|id| id.to_string())
        .ok_or_else(|| crate::error::AppError::NotFound {
            code: "ACL_USER_NOT_FOUND".to_string(),
            message: "授权用户不存在、未加入当前租户或未启用".to_string(),
        })
}

fn normalize_acl_subject_type(value: &str) -> Result<&str, crate::error::AppError> {
    match value.trim() {
        "role" => Ok("role"),
        "user" => Ok("user"),
        _ => Err(crate::error::AppError::bad_request(
            "ACL_SUBJECT_TYPE_INVALID",
            "授权对象类型只能是 role 或 user",
        )),
    }
}

fn normalize_acl_permission(value: &str) -> Result<&str, crate::error::AppError> {
    match value.trim() {
        "read" => Ok("read"),
        "write" => Ok("write"),
        "manage" => Ok("manage"),
        _ => Err(crate::error::AppError::bad_request(
            "ACL_PERMISSION_INVALID",
            "授权权限只能是 read / write / manage",
        )),
    }
}

async fn fetch_permission(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    acl_id: Uuid,
) -> Result<KnowledgeBaseAuthorization, crate::error::AppError> {
    let row = sqlx::query(
        r#"
        SELECT acl.id,
               acl.tenant_id,
               acl.kb_id,
               kb.name AS kb_name,
               acl.subject_type,
               acl.subject_id,
               acl.permission,
               acl.created_by,
               COALESCE(NULLIF(u.name, ''), u.email) AS user_label,
               COALESCE(NULLIF(c.name, ''), c.email) AS created_by_label,
               acl.created_at
        FROM knowledge_base_acl acl
        JOIN knowledge_base kb
          ON kb.tenant_id = acl.tenant_id
         AND kb.id = acl.kb_id
        LEFT JOIN app_user u
          ON acl.subject_type = 'user'
         AND u.id::text = acl.subject_id
        LEFT JOIN app_user c
          ON c.id = acl.created_by
        WHERE acl.tenant_id = $1
          AND acl.id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(acl_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::error::AppError::NotFound {
        code: "ACL_NOT_FOUND".to_string(),
        message: "授权记录不存在或无权限".to_string(),
    })?;

    Ok(permission_from_row(row))
}

fn permission_from_row(row: sqlx::postgres::PgRow) -> KnowledgeBaseAuthorization {
    let subject_type: String = row.get("subject_type");
    let subject_id: String = row.get("subject_id");
    let user_label: Option<String> = row.try_get("user_label").ok();
    let subject_label = if subject_type == "user" {
        user_label.unwrap_or_else(|| subject_id.clone())
    } else {
        subject_id.clone()
    };

    KnowledgeBaseAuthorization {
        id: row.get("id"),
        tenant_id: row.get("tenant_id"),
        kb_id: row.get("kb_id"),
        kb_name: row.get("kb_name"),
        subject_type,
        subject_id,
        subject_label,
        permission: row.get("permission"),
        created_by: row.try_get("created_by").ok(),
        created_by_label: row.try_get("created_by_label").ok(),
        created_at: row.get("created_at"),
    }
}

fn provider_name(base_url: &str) -> &'static str {
    let normalized = base_url.to_ascii_lowercase();
    if normalized.contains("dashscope") || normalized.contains("aliyuncs") {
        "DashScope"
    } else if normalized.contains("openai") {
        "OpenAI"
    } else if normalized.contains("deepseek") {
        "DeepSeek"
    } else {
        "OpenAI-compatible"
    }
}
