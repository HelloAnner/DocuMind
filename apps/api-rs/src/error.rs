use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    NotFound { code: String, message: String },
    Forbidden { code: String, message: String },
    Conflict { code: String, message: String },
    InvalidState { code: String, message: String },
    Timeout { code: String, message: String },
    Internal(anyhow::Error),
    BadRequest { code: String, message: String },
}

impl AppError {
    pub fn conversation_not_found() -> Self {
        Self::NotFound {
            code: "CONVERSATION_NOT_FOUND".to_string(),
            message: "会话不存在或无权限".to_string(),
        }
    }
    pub fn message_not_found() -> Self {
        Self::NotFound {
            code: "MESSAGE_NOT_FOUND".to_string(),
            message: "消息不存在或无权限".to_string(),
        }
    }
    pub fn kb_scope_denied() -> Self {
        Self::Forbidden {
            code: "KB_SCOPE_DENIED".to_string(),
            message: "请求知识库超出用户权限".to_string(),
        }
    }
    pub fn client_request_conflict() -> Self {
        Self::Conflict {
            code: "CLIENT_REQUEST_CONFLICT".to_string(),
            message: "幂等 ID 冲突".to_string(),
        }
    }
    pub fn invalid_message_state() -> Self {
        Self::InvalidState {
            code: "INVALID_MESSAGE_STATE".to_string(),
            message: "当前状态不允许该操作".to_string(),
        }
    }
    pub fn pipeline_timeout() -> Self {
        Self::Timeout {
            code: "PIPELINE_TIMEOUT".to_string(),
            message: "RAG 管线超时".to_string(),
        }
    }
    pub fn llm_timeout() -> Self {
        Self::Timeout {
            code: "LLM_TIMEOUT".to_string(),
            message: "LLM 生成超时".to_string(),
        }
    }
    pub fn forbidden() -> Self {
        Self::Forbidden {
            code: "FORBIDDEN".to_string(),
            message: "当前身份无权执行该操作".to_string(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            AppError::NotFound { code, message } => (StatusCode::NOT_FOUND, code.clone(), message.clone()),
            AppError::Forbidden { code, message } => (StatusCode::FORBIDDEN, code.clone(), message.clone()),
            AppError::Conflict { code, message } => (StatusCode::CONFLICT, code.clone(), message.clone()),
            AppError::InvalidState { code, message } => (StatusCode::CONFLICT, code.clone(), message.clone()),
            AppError::Timeout { code, message } => (StatusCode::GATEWAY_TIMEOUT, code.clone(), message.clone()),
            AppError::Internal(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR".to_string(),
                format!("{e}"),
            ),
            AppError::BadRequest { code, message } => (StatusCode::BAD_REQUEST, code.clone(), message.clone()),
        };
        let body = Json(json!({ "code": code, "message": message }));
        (status, body).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        AppError::Internal(err.into())
    }
}
