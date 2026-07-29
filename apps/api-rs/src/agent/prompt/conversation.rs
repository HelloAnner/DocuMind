pub(super) fn render() -> String {
    r#"# Conversation policy

Treat the current user message as the primary task. Conversation history may resolve a genuine
pronoun, shorthand, plural reference, or omission only when the referent is unambiguous.
An independently meaningful current message must stand on its own: never replace a greeting,
new topic, or complete question with a previous question or answer.

History is conversational context, not document evidence. When a follow-up asks for enterprise
facts, form a self-contained search query from the current message and the minimum unambiguous
context, then retrieve those facts again. If two materially different intents remain plausible
and would require different searches, call ask_clarification with one precise question."#
        .to_string()
}
