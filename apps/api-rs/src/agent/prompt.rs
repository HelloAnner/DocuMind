use anyhow::Result;

use crate::models::agent::{AgentMode, AgentOptions};
use crate::models::rag::EvidencePack;

#[derive(Debug, Clone)]
pub struct Prompt {
    pub full_text: String,
    pub persona_version: String,
    pub guardrail_version: String,
    pub mode_version: String,
    pub task_version: String,
}

#[async_trait::async_trait]
pub trait PromptRegistry: Send + Sync {
    async fn compose(
        &self,
        mode: AgentMode,
        original_query: &str,
        rewritten_query: Option<&str>,
        history: &str,
        evidence: &EvidencePack,
        options: &AgentOptions,
    ) -> Result<Prompt>;
}

pub struct BuiltinPromptRegistry;

impl BuiltinPromptRegistry {
    pub fn new() -> Self {
        Self
    }
}

impl Default for BuiltinPromptRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl PromptRegistry for BuiltinPromptRegistry {
    async fn compose(
        &self,
        mode: AgentMode,
        original_query: &str,
        rewritten_query: Option<&str>,
        history: &str,
        evidence: &EvidencePack,
        options: &AgentOptions,
    ) -> Result<Prompt> {
        let persona = "你是 DocuMind，一个企业知识伙伴。你的表达可信、简洁、温和，目标是帮助用户推进真实工作。你可以在必要时澄清、总结、对比、提醒风险或建议下一步。但企业事实必须来自文档证据，关键结论必须可引用。";

        let guardrail = "硬性规则：\n1. 不使用文档片段之外的内容回答企业事实。\n2. 不编造文档名、页码、条款编号、金额、日期、负责人。\n3. 历史对话只用于理解意图，不作为事实来源。\n4. 证据不足时说明“文档中未找到相关信息”。\n5. 如果问题有多个可能指代对象，先澄清。";

        let mode_instruction = match mode {
            AgentMode::Answerer => "当前模式：answerer。请直接回答用户问题，先给结论，再列依据。",
            AgentMode::Clarifier => "当前模式：clarifier。请提出一个简短澄清问题，给出最可能的 2-3 个候选对象，不要直接回答原问题。",
            AgentMode::Summarizer => "当前模式：summarizer。请按文档结构分层摘要，并标注关键引用。",
            AgentMode::Comparer => "当前模式：comparer。请按清晰维度对比多个对象，每个差异点都必须标注来源；若某对象缺少证据，用“未找到明确说明”标注。",
            AgentMode::Analyst => "当前模式：analyst。你可以基于文档证据做结构化分析，但不能给超出文档的最终裁决；区分“文档明确写了什么”“可以推导出的风险”“仍需要人工确认的部分”。",
            AgentMode::Navigator => "当前模式：navigator。请给出文档位置与原文摘录。",
            AgentMode::Reviewer => "当前模式：reviewer。请给出检查清单与已发现证据。",
        };

        let rewritten_section = if let Some(rq) = rewritten_query {
            format!("改写后用于检索的问题：{rq}\n")
        } else {
            String::new()
        };

        let full_text = format!(
            "{persona}\n\n{guardrail}\n\n{mode_instruction}\n\n语气：{tone}\n\n<history intent_only=\"true\">\n{history}\n</history>\n\n{rewritten_section}<context>\n{context}\n</context>\n\n<question>\n{original_query}\n</question>\n\n请按当前模式回答，并满足：\n- 先给结论\n- 关键结论带引用 [1][2]\n- 说明不能确认的部分\n- 语言简洁、温和、专业\n",
            tone = options.tone,
            context = evidence.context_text,
        );

        Ok(Prompt {
            full_text,
            persona_version: "persona-v1".to_string(),
            guardrail_version: "grounded-guardrail-v1".to_string(),
            mode_version: format!("mode-{mode}-v1"),
            task_version: "grounded-task-v1".to_string(),
        })
    }
}
