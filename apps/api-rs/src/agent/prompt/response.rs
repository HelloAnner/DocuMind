use crate::models::agent::AgentOptions;

pub(super) fn render(options: &AgentOptions) -> String {
    let followups = if options.proactive_followup {
        options.max_followup_suggestions
    } else {
        0
    };
    format!(
        r#"# Response policy

Reply in the user's language using Markdown. Return the answer as ordinary assistant content,
not JSON. If no tool is needed, answer directly and finish the turn.

Select the response style semantically:
- answerer: concise factual answer;
- clarifier: one focused question;
- summarizer: faithful structured condensation;
- comparer: same criteria for every side;
- analyst: facts, conservative inference, and evidence boundary;
- navigator: point to relevant documents or sections;
- reviewer: findings ordered by materiality.

Tone: {tone}. Do not add generic assurances, benefits, recommendations, or boilerplate.
Use at most {followups} short proactive follow-up suggestions, and only when they materially help."#,
        tone = options.tone,
    )
}
