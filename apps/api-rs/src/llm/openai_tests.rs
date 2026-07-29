use super::*;

#[test]
fn strips_json_fences() {
    let raw = "```json\n{\"a\":1}\n```";
    assert_eq!(super::strip_json_fences(raw), "{\"a\":1}");
}

#[test]
fn repairs_unescaped_control_characters_inside_json_strings() {
    let raw = "{\"answer\":\"第一行\n第二行\t内容\"}";
    let value: Value = parse_json_completion(raw).expect("completion should be repaired");
    assert_eq!(value["answer"], "第一行\n第二行\t内容");
}

#[test]
fn preserves_pretty_json_whitespace_outside_strings() {
    let raw = "{\n  \"answer\": \"内容\"\n}";
    let value: Value = parse_json_completion(raw).expect("pretty JSON should parse");
    assert_eq!(value["answer"], "内容");
}

#[test]
fn parses_sse_data_line() {
    let event = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}";
    assert_eq!(
        parse_sse_event(event),
        ParsedStreamEvent::Delta("hello".to_string())
    );
}

#[test]
fn parses_sse_done_line() {
    let event = "data: [DONE]";
    assert_eq!(parse_sse_event(event), ParsedStreamEvent::Done);
}

#[test]
fn parses_provider_error_event() {
    let event = "data: {\"error\":{\"message\":\"bad key\"}}";
    assert_eq!(
        parse_sse_event(event),
        ParsedStreamEvent::Error("bad key".to_string())
    );
}

#[test]
fn finds_lf_and_crlf_separators() {
    assert_eq!(find_sse_separator("a\n\nb"), Some((1, 2)));
    assert_eq!(find_sse_separator("a\r\n\r\nb"), Some((1, 4)));
}

#[test]
fn chat_completion_request_serializes_messages() {
    let request = ChatCompletionRequest {
        model: "qwen-turbo".to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: "system content".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: "user content".to_string(),
            },
        ],
        temperature: 0.2,
        max_tokens: 1200,
        stream: true,
    };
    let json = serde_json::to_value(&request).expect("request should serialize");
    let messages = json["messages"]
        .as_array()
        .expect("messages should be an array");
    assert_eq!(json["model"], "qwen-turbo");
    assert_eq!(messages.len(), 2);
    assert_eq!(json["messages"][0]["role"], "system");
    assert_eq!(json["messages"][1]["content"], "user content");
}
