// A Claude Sonnet 5.5 tool turn of two tool steps, as the Messages API returns
// it to a request sent with `thinking: {type: "adaptive", display: "updates"}`.
// The bodies follow the shapes in Anthropic's thinking docs
// (https://platform.claude.com/docs/en/build-with-claude/thinking): reasoning
// blocks arrive with an empty `thinking` field, progress-update blocks carry
// their summary text and sit immediately before the `tool_use` they
// introduce, and every block carries an opaque `signature`. The signatures
// and redacted data here are made up; the API treats them as opaque, and so
// must the adapter.

export const SONNET_55_STEP_1 = {
  id: "msg_step_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    { type: "thinking", thinking: "", signature: "sig-reasoning-1" },
    { type: "text", text: "I'll start with the directory." },
    {
      type: "thinking",
      thinking: "Listing the budget directory to find its modules.",
      signature: "sig-update-1",
    },
    {
      type: "tool_use",
      id: "toolu_list",
      name: "list_files",
      input: { path: "." },
    },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 120, output_tokens: 410 },
} as const;

export const SONNET_55_STEP_2 = {
  id: "msg_step_2",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    { type: "redacted_thinking", data: "redacted-blob-2" },
    { type: "thinking", thinking: "", signature: "sig-reasoning-2" },
    {
      type: "thinking",
      thinking: "Found README.md. Reading it for the first heading.",
      signature: "sig-update-2",
    },
    {
      type: "tool_use",
      id: "toolu_read",
      name: "read_file",
      input: { path: "README.md" },
    },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 180, output_tokens: 520 },
} as const;

export const SONNET_55_FINAL = {
  id: "msg_final",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    { type: "thinking", thinking: "", signature: "sig-reasoning-3" },
    { type: "text", text: "The first heading is readme." },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 240, output_tokens: 300 },
} as const;
