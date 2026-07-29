use std::sync::Arc;
use std::time::Duration;

use tracing::warn;
use uuid::Uuid;

use crate::agent::model::{AgentMessage, AgentModelRequest};
use crate::agent::AgentModel;
use crate::models::{MessageRole, MessageStatus};
use crate::repositories::ConversationRepository;

const MAX_TITLE_CHARS: usize = 10;
const UPDATE_INTERVAL: usize = 4;
const FIRST_RECURRING_UPDATE: usize = 3;
const RECENT_TURNS: usize = 3;
const TITLE_TIMEOUT: Duration = Duration::from_secs(12);

const TITLE_SYSTEM_PROMPT: &str = r#"你是专业的会话标题生成器。请为对话生成简洁的中文标题。

规则：
1. 标题不超过 10 个字
2. 提炼核心主题或用户意图
3. 使用名词短语
4. 不使用标点、引号或书名号
5. 只输出标题，不要解释"#;

pub fn spawn_title_update(
    repository: Arc<dyn ConversationRepository>,
    model: Arc<dyn AgentModel>,
    tenant_id: Uuid,
    user_id: Uuid,
    conversation_id: Uuid,
) -> tokio::task::JoinHandle<Option<String>> {
    tokio::spawn(async move {
        match generate_and_update_title(&repository, model, tenant_id, user_id, conversation_id)
            .await
        {
            Ok(title) => title,
            Err(error) => {
                warn!(
                    %conversation_id,
                    error = %error,
                    "asynchronous conversation title generation failed"
                );
                None
            }
        }
    })
}

async fn generate_and_update_title(
    repository: &Arc<dyn ConversationRepository>,
    model: Arc<dyn AgentModel>,
    tenant_id: Uuid,
    user_id: Uuid,
    conversation_id: Uuid,
) -> anyhow::Result<Option<String>> {
    let session = match repository.get_session(tenant_id, conversation_id).await? {
        Some(session) if session.user_id == user_id => session,
        _ => return Ok(None),
    };
    let messages = repository.get_messages(tenant_id, conversation_id).await?;
    let user_message_count = messages
        .iter()
        .filter(|message| message.role == MessageRole::User)
        .count();
    if !should_generate_title(user_message_count) {
        return Ok(None);
    }
    if user_message_count == 1 && session.title.trim() != "新会话" {
        return Ok(None);
    }

    let prompt = if user_message_count == 1 {
        let first_message = messages
            .iter()
            .find(|message| message.role == MessageRole::User)
            .map(|message| truncate_chars(&message.content, 500))
            .unwrap_or_default();
        format!(
            "请为以下用户消息生成一个 10 字以内的中文标题：\n\n用户消息：\n{first_message}\n\n请直接输出标题："
        )
    } else {
        format!(
            "请根据以下对话生成一个 10 字以内的中文标题：\n\n{}\n\n请直接输出标题：",
            recent_conversation(&messages)
        )
    };

    let request = AgentModelRequest {
        messages: vec![
            AgentMessage::system(TITLE_SYSTEM_PROMPT),
            AgentMessage::user(prompt),
        ],
        tools: Vec::new(),
        temperature: 0.2,
        max_tokens: 32,
    };
    let response = tokio::time::timeout(TITLE_TIMEOUT, model.complete(request)).await??;
    let Some(title) = response.content.as_deref().and_then(normalize_title) else {
        return Ok(None);
    };
    let updated = repository
        .update_session_title(tenant_id, user_id, conversation_id, &title, false)
        .await?;
    Ok(updated.then_some(title))
}

fn should_generate_title(user_message_count: usize) -> bool {
    user_message_count == 1
        || (user_message_count >= FIRST_RECURRING_UPDATE
            && (user_message_count - FIRST_RECURRING_UPDATE) % UPDATE_INTERVAL == 0)
}

fn recent_conversation(messages: &[crate::models::message::ConversationMessage]) -> String {
    let mut recent = Vec::new();
    let mut user_count = 0usize;
    for message in messages.iter().rev().filter(|message| {
        message.role == MessageRole::User
            || (message.role == MessageRole::Assistant
                && message.status == MessageStatus::Completed)
    }) {
        recent.push(message);
        if message.role == MessageRole::User {
            user_count += 1;
            if user_count == RECENT_TURNS {
                break;
            }
        }
    }
    recent.reverse();

    recent
        .into_iter()
        .map(|message| {
            let role = if message.role == MessageRole::User {
                "用户"
            } else {
                "助手"
            };
            format!("{role}：{}", truncate_chars(&message.content, 200))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_title(raw: &str) -> Option<String> {
    let first_line = raw.lines().next()?.trim();
    let clean = first_line
        .trim_matches(|character| {
            matches!(
                character,
                '"' | '\'' | '“' | '”' | '‘' | '’' | '《' | '》' | '。' | '！' | '？'
            )
        })
        .trim();
    if clean.is_empty() {
        return None;
    }
    Some(truncate_chars(clean, MAX_TITLE_CHARS))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moss_title_update_cadence_is_preserved() {
        let due = (0..12)
            .filter(|count| should_generate_title(*count))
            .collect::<Vec<_>>();
        assert_eq!(due, vec![1, 3, 7, 11]);
    }

    #[test]
    fn title_is_single_line_unquoted_and_ten_chars() {
        assert_eq!(
            normalize_title("“企业知识库检索性能优化”\n解释").as_deref(),
            Some("企业知识库检索性能优")
        );
    }
}
