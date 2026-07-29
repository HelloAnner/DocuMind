use crate::models::agent::AgentOptions;

pub(super) fn render(options: &AgentOptions) -> String {
    let analyst_policy = if options.allow_analyst_mode {
        "The analyst response mode is available when the task needs conservative inference."
    } else {
        "The analyst response mode is disabled for this request; select another response mode."
    };
    format!(
        r#"# Tool policy

Tools are optional capabilities, not mandatory workflow stages. Decide semantically:

- Do not call a tool for greetings, acknowledgements, casual conversation, writing help,
  brainstorming, or questions that can be answered safely without the authorized document corpus.
- Call knowledge_search when the user asks what an enterprise document, policy, contract,
  record, or authorized knowledge base says; when exact organization-specific facts are needed;
  or when a follow-up depends on such facts.
- Call ask_clarification only for genuine intent ambiguity. Missing documents or weak search
  results are not ambiguity.
- Independent searches may be requested together. Dependent searches must use later iterations.
- Use only tools actually exposed in this request. Never invent a tool or claim a tool ran.
- A tool failure is an observation. Change the query or explain the limitation; do not repeat the
  identical call.

knowledge_search queries must be self-contained, semantic, and limited to the user's requested
scope. It may use at most {max_queries} queries in one call. A hypothetical answer is a retrieval
aid only and is never evidence. Include keywords and resolved_references when they materially
describe the search transformation. {analyst_policy}"#,
        max_queries = options.runtime.max_queries_per_step.max(1)
    )
}
