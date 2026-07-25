use serde_json::Value;

/// What a single JSONL line means for the companion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detected {
    Thinking,
    Coding,
    Searching,
    Speaking,
    Success, // agent finished a turn (end_turn) -> +star
    Error,   // a tool_result came back with is_error
}

impl Detected {
    /// State key sent to the frontend (sprite + phrase pool).
    pub fn state_key(self) -> &'static str {
        match self {
            Detected::Thinking => "thinking",
            Detected::Coding => "coding",
            Detected::Searching => "searching",
            Detected::Speaking => "speaking",
            Detected::Success => "success",
            Detected::Error => "error",
        }
    }

    pub fn star_delta(self) -> i64 {
        match self {
            Detected::Success => 1,
            Detected::Error => -1,
            _ => 0,
        }
    }
}

fn tool_state(name: &str) -> Detected {
    match name {
        "Bash" | "Edit" | "Write" | "NotebookEdit" | "MultiEdit" => Detected::Coding,
        "Grep" | "Glob" | "Read" | "WebSearch" | "WebFetch" | "LS" => Detected::Searching,
        _ => Detected::Coding,
    }
}

/// Classify one parsed JSONL line. Returns None for lines we don't react to
/// (queue-operation, system, attachments, plain user prompts, ...).
pub fn classify(v: &Value) -> Option<Detected> {
    match v.get("type").and_then(Value::as_str)? {
        "assistant" => {
            let msg = v.get("message")?;
            let stop = msg.get("stop_reason").and_then(Value::as_str);

            // A finished turn is the "task done" signal regardless of blocks.
            if stop == Some("end_turn") {
                return Some(Detected::Success);
            }

            // Otherwise the last meaningful block drives the state: the agent
            // usually ends a mid-task response on the tool it is about to run.
            let content = msg.get("content")?.as_array()?;
            let mut state = None;
            for b in content {
                match b.get("type").and_then(Value::as_str) {
                    Some("thinking") => state = Some(Detected::Thinking),
                    Some("text") => state = Some(Detected::Speaking),
                    Some("tool_use") => {
                        let name = b.get("name").and_then(Value::as_str).unwrap_or("");
                        state = Some(tool_state(name));
                    }
                    _ => {}
                }
            }
            state
        }
        "user" => {
            // tool_result blocks live inside a synthetic user message.
            let content = v.get("message")?.get("content")?.as_array()?;
            for b in content {
                if b.get("type").and_then(Value::as_str) == Some("tool_result")
                    && b.get("is_error") == Some(&Value::Bool(true))
                {
                    return Some(Detected::Error);
                }
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn end_turn_is_success() {
        let v = json!({
            "type": "assistant",
            "message": { "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": "done" }] }
        });
        assert_eq!(classify(&v), Some(Detected::Success));
        assert_eq!(Detected::Success.star_delta(), 1);
    }

    #[test]
    fn thinking_then_tooluse_ends_on_tool() {
        let v = json!({
            "type": "assistant",
            "message": { "stop_reason": "tool_use", "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "tool_use", "name": "Edit", "input": {} }
            ]}
        });
        assert_eq!(classify(&v), Some(Detected::Coding));
    }

    #[test]
    fn read_tool_is_searching() {
        let v = json!({
            "type": "assistant",
            "message": { "stop_reason": "tool_use", "content": [
                { "type": "tool_use", "name": "Grep", "input": {} }
            ]}
        });
        assert_eq!(classify(&v), Some(Detected::Searching));
    }

    #[test]
    fn thinking_only() {
        let v = json!({
            "type": "assistant",
            "message": { "stop_reason": "tool_use", "content": [
                { "type": "thinking", "thinking": "hmm" }
            ]}
        });
        assert_eq!(classify(&v), Some(Detected::Thinking));
    }

    #[test]
    fn tool_result_error_is_error() {
        let v = json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "x", "is_error": true, "content": "boom" }
            ]}
        });
        assert_eq!(classify(&v), Some(Detected::Error));
        assert_eq!(Detected::Error.star_delta(), -1);
    }

    #[test]
    fn successful_tool_result_is_ignored() {
        let v = json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "x", "content": "ok" }
            ]}
        });
        assert_eq!(classify(&v), None);
    }

    #[test]
    fn noise_lines_ignored() {
        for t in ["queue-operation", "system", "attachment", "custom-title"] {
            let v = json!({ "type": t });
            assert_eq!(classify(&v), None, "type {t} should be ignored");
        }
        // a plain user prompt (string content) must not react
        let prompt = json!({ "type": "user", "message": { "role": "user", "content": "hi" }});
        assert_eq!(classify(&prompt), None);
    }
}
