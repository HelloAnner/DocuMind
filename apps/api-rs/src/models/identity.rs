use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct CurrentActor {
    pub user_id: Uuid,
    pub tenant_id: Uuid,
    pub email: String,
    pub name: String,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    pub allowed_kb_ids: Vec<Uuid>,
    pub is_super_admin: bool,
}

impl CurrentActor {
    pub fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|r| r == role)
    }

    pub fn has_permission(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }

    pub fn can_manage_kb(&self, kb_id: Uuid) -> bool {
        self.allowed_kb_ids.contains(&kb_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeResponse {
    pub user: UserProfile,
    pub tenant: TenantProfile,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    pub allowed_kb_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: Uuid,
    pub email: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantProfile {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub plan: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantSummary {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub status: String,
    pub plan: String,
    pub member_count: i64,
    pub kb_count: i64,
    pub doc_count: i64,
    pub monthly_queries: i64,
    pub active_admin_count: i64,
    pub pending_invitation_count: i64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemUserSummary {
    pub id: Uuid,
    pub email: String,
    pub name: Option<String>,
    pub status: String,
    pub tenants: Vec<String>,
    pub last_login_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelService {
    pub id: Uuid,
    pub name: String,
    pub model: String,
    pub base_url: String,
    pub api_key_tail: String,
    pub status: String,
    pub throughput: String,
    pub latency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSummary {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub tenant_name: String,
    pub kind: String,
    pub status: String,
    pub progress: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBaseSummary {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub tags: Vec<String>,
    pub doc_count: i64,
    pub chunk_count: i64,
    pub query_count: i64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberSummary {
    pub id: Uuid,
    pub email: String,
    pub name: Option<String>,
    pub roles: Vec<String>,
    pub allowed_kb_names: Vec<String>,
    pub query_count: i64,
    pub status: String,
    pub joined_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QaLogSummary {
    pub id: Uuid,
    pub question: String,
    pub kb_name: String,
    pub user_name: String,
    pub score: f64,
    pub feedback: Option<String>,
    pub created_at: DateTime<Utc>,
}
