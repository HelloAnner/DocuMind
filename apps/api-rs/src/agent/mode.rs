use anyhow::Result;

use crate::models::agent::{AgentMode, ConversationTurn};

#[async_trait::async_trait]
pub trait ModeSelector: Send + Sync {
    async fn select(&self, original_query: &str, history: &[ConversationTurn])
        -> Result<AgentMode>;
}

pub struct RuleBasedModeSelector;

impl RuleBasedModeSelector {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RuleBasedModeSelector {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ModeSelector for RuleBasedModeSelector {
    async fn select(
        &self,
        original_query: &str,
        _history: &[ConversationTurn],
    ) -> Result<AgentMode> {
        let q = original_query.to_lowercase();
        if q.contains("对比")
            || q.contains("区别")
            || q.contains("相比")
            || q.contains("和") && q.contains("比")
        {
            return Ok(AgentMode::Comparer);
        }
        if q.contains("总结") || q.contains("摘要") || q.contains("讲了什么") {
            return Ok(AgentMode::Summarizer);
        }
        if q.contains("在哪") || q.contains("哪一页") || q.contains("哪里提到") {
            return Ok(AgentMode::Navigator);
        }
        if q.contains("检查") || q.contains("遗漏") || q.contains("完整") {
            return Ok(AgentMode::Reviewer);
        }
        if q.contains("是否")
            || q.contains("风险")
            || q.contains("合理")
            || q.contains("违法")
            || q.contains("违规")
        {
            return Ok(AgentMode::Analyst);
        }
        if q.contains("它") || q.contains("这个") || q.contains("那份") || q.contains("上面")
        {
            return Ok(AgentMode::Clarifier);
        }
        Ok(AgentMode::Answerer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn selects_comparer_for_comparison() {
        let selector = RuleBasedModeSelector::new();
        let mode = selector.select("A 和 B 有什么区别", &[]).await.unwrap();
        assert_eq!(mode, AgentMode::Comparer);
    }

    #[tokio::test]
    async fn selects_analyst_for_risk() {
        let selector = RuleBasedModeSelector::new();
        let mode = selector.select("这样是否违规", &[]).await.unwrap();
        assert_eq!(mode, AgentMode::Analyst);
    }

    #[tokio::test]
    async fn defaults_to_answerer() {
        let selector = RuleBasedModeSelector::new();
        let mode = selector.select("付款节点是什么", &[]).await.unwrap();
        assert_eq!(mode, AgentMode::Answerer);
    }
}
