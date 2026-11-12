use crate::approval_fields::{FieldValue, field, render_fields, visible};
use serde_json::Value;

pub fn is_external(params: &Value) -> bool {
    params.get("kind").and_then(Value::as_str) == Some("external_agent_permission")
}

fn text(value: &Value) -> String {
    value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())
}

pub fn preamble(params: &Value, model: Option<&str>) -> String {
    let agent = match model {
        Some(slug) => format!("the external agent {}", visible(slug)),
        None => "the external agent".into(),
    };
    let title = params.get("title").and_then(Value::as_str)
        .or_else(|| params.get("commandId").and_then(Value::as_str)).unwrap_or("tool");
    let mut rendered = format!("\n⚠  {agent} is asking: {}\n", visible(title));
    let Some(arguments) = params.get("arguments") else { return rendered };
    let Some(args) = arguments.as_object() else {
        rendered.push_str(&field("arguments", &text(arguments)));
        return rendered;
    };
    for key in ["ACP kind", "ACP tool"] {
        if let Some(value) = args.get(key) {
            if key == "ACP tool" && value.as_str() == Some("(not supplied)") {
                continue;
            }
            rendered.push_str(&field(key, &text(value)));
        }
    }
    if let Some(value) = args.get("Requested input") {
        let raw = text(value);
        let fields = serde_json::from_str::<FieldValue>(&raw).ok()
            .and_then(|parsed| render_fields(&parsed));
        match fields {
            Some(fields) if !fields.is_empty() => rendered.push_str(&fields),
            Some(_) => rendered.push_str(&field("Requested input", "{}")),
            None => {
                rendered.push_str(&field("Requested input", &visible(&raw)));
                rendered.push_str("   input could not be read as fields and may be cut off at the runtime's 2,048-byte limit\n");
            }
        }
    }
    for (key, value) in args {
        if !["ACP kind", "ACP tool", "Requested input"].contains(&key.as_str()) {
            rendered.push_str(&field(key, &text(value)));
        }
    }
    rendered
}

pub fn option_description(kind: &str) -> &'static str {
    match kind {
        "allow_once" => "Allow this request once.",
        "allow_always" => "Allow this request; the external agent keeps the approval rule, not Workbench.",
        "reject_once" => "Reject this request once.",
        "reject_always" => "Reject this request; the external agent keeps the rejection rule, not Workbench.",
        _ => "",
    }
}
