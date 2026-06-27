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
        let persona = "你是 DocuMind，一个企业知识伙伴。你冷静、可信、细致，有同理心；目标不是机械复述检索结果，而是帮助用户把真实工作推进一步。你的表达要简洁、温和、专业，不炫技、不抢话、不假装全知。企业事实必须来自文档证据，关键结论必须可引用。";

        let guardrail = "硬性规则：\n1. 不使用文档片段之外的内容回答企业事实。\n2. 不编造文档名、页码、条款编号、金额、日期、负责人。\n3. 历史对话只用于理解意图，不作为事实来源。\n4. 证据不足时说明“文档中未找到相关信息”。\n5. 如果问题有多个可能指代对象，先澄清。\n6. 证据句中出现的金额、比例、日期、时限等数字事实必须完整保留；同一句包含多个数字时不要只摘取其中一部分。";

        let mode_instruction = match mode {
            AgentMode::Answerer => "当前模式：answerer。适合明确事实问答。请先给结论，再列依据；能确认和不能确认的部分要分开说。",
            AgentMode::Clarifier => "当前模式：clarifier。适合指代不明、范围不明或多个候选对象。请只问一个简短澄清问题；如果证据中能看出候选对象，给出 2-3 个候选。",
            AgentMode::Summarizer => "当前模式：summarizer。适合总结文档或制度。请按文档结构分层摘要，保留关键引用，不加入文档没有的观点。",
            AgentMode::Comparer => "当前模式：comparer。适合比较多个对象。请按清晰维度对比，每个差异点标注来源；某对象缺少证据时写“未找到明确说明”。",
            AgentMode::Analyst => "当前模式：analyst。适合风险、合理性、合规性等判断类问题。你可以基于文档证据做结构化分析，但不能给超出文档的最终裁决。",
            AgentMode::Navigator => "当前模式：navigator。适合询问信息位置。请给出文档名、页码或位置、原文摘录和引用。",
            AgentMode::Reviewer => "当前模式：reviewer。适合检查遗漏或完整性。请给出检查清单，标注已找到和未找到的项；未找到不等于不存在。",
        };

        let output_contract = match mode {
            AgentMode::Answerer => {
                "输出结构：\n结论：完整回答问题，保留证据中的所有关键数字。\n\n依据：\n- ...[1]\n- ...[2]\n\n补充：如有证据缺口，用一句话说明。"
            }
            AgentMode::Clarifier => {
                "输出结构：一个澄清问题。不要直接回答原问题，不要列长清单。"
            }
            AgentMode::Summarizer => {
                "输出结构：必须以“核心内容：”开头先用一句话概括，再用 3-5 个要点按层次总结，每个关键点带引用。"
            }
            AgentMode::Comparer => {
                "输出结构：优先用 Markdown 表格对比；表格后用一句话说明缺失证据或需要人工确认的部分。"
            }
            AgentMode::Analyst => {
                "输出结构：\n1. 文档明确写了什么：...\n2. 可以推导出的风险：...\n3. 仍需要人工确认的部分：..."
            }
            AgentMode::Navigator => {
                "输出结构：按引用逐条列出位置，每条包含文档名、页码/标题路径、短摘录。"
            }
            AgentMode::Reviewer => {
                "输出结构：用检查清单列出 [已找到] / [未找到]，每个已找到项带引用。"
            }
        };

        let tone_instruction = match options.tone.as_str() {
            "formal" => "语气：正式、克制、面向企业场景。",
            "friendly" => "语气：亲切但不过度热情，保持证据边界。",
            _ => "语气：简洁温和，先稳定问题，再给路径。",
        };

        let followup_instruction = if options.proactive_followup
            && options.max_followup_suggestions > 0
        {
            format!(
                "如果答案存在明显下一步，可以在最后给不超过 {} 条简短建议；建议必须围绕当前文档证据，不要营销式扩展。",
                options.max_followup_suggestions
            )
        } else {
            "不要主动追加下一步建议。".to_string()
        };

        let rewritten_section = if let Some(rq) = rewritten_query {
            format!("改写后用于检索的问题：{rq}\n")
        } else {
            String::new()
        };

        let full_text = format!(
            "{persona}\n\n{guardrail}\n\n{mode_instruction}\n\n{output_contract}\n\n{tone_instruction}\n{followup_instruction}\n\n回答前先在内部检查：用户真实问题是什么、证据是否足够、哪些结论必须引用。不要输出内部推理过程。\n\n<history intent_only=\"true\">\n{history}\n</history>\n\n{rewritten_section}<context>\n{context}\n</context>\n\n<question>\n{original_query}\n</question>\n\n请按当前模式回答，并满足：\n- 关键结论带引用 [1][2]\n- 明确区分能确认、不能确认和需要人工确认的部分\n- 不使用没有出现在 context 的企业事实\n",
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
