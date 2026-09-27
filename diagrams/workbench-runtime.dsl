workspace "DYFJ Workbench Runtime" "C4 views for the Workbench runtime and its CLI over UDS." {
  model {
    operator = person "Operator" "Runs local Workbench turns from the CLI over UDS."
    ollama = softwareSystem "Ollama" "External local model runtime used for Tier 0 inference (MLX-LM Server is an optional alternative)."
    hostedInference = softwareSystem "Hosted Model APIs" "External paid inference endpoints (Anthropic, OpenAI, OpenRouter, Google Gemini, xAI) used only with paid approval."
    acpAgents = softwareSystem "ACP Agents" "Local external agents (the deterministic fixture, codex-acp) launched as stdio children for --runner turns."
    mcpServers = softwareSystem "External MCP Servers" "Configured Streamable HTTP servers behind allowlisted tools, including web_search and web_fetch."

    dyfj = softwareSystem "DYFJ" "Local-first AI workbench and automation framework." {
      cli = container "Workbench CLI" "Parses command-line input, runs the interactive REPL, renders text output and receipts." "Deno / TypeScript"
      uds = container "JSON-RPC/UDS Seam" "Exposes the local Unix-socket JSON-RPC transport." "Deno / TypeScript"
      runtime = container "Workbench Runtime" "Executes one Workbench turn: context loading, model routing, command/tool calls, events, sessions, budgets, and receipt facts; runs external-agent turns over ACP." "TypeScript"
      commands = container "Command Registry" "Projects bounded commands as model tools and executes policy-checked command calls." "TypeScript"
      modelRouter = container "Provider Path" "Selects a model, shapes OpenAI-compatible, Anthropic, and Gemini requests, parses responses, tool calls, timings, usage, and cost." "TypeScript"
      dolt = container "Dolt Data Store" "Canonical schema, events, sessions, memories, model registry, and budget/event records." "Dolt SQL"
    }

    operator -> cli "Runs prompts and REPL commands"
    cli -> uds "JSON-RPC over Unix socket"
    uds -> runtime "Invokes single-turn runtime"
    runtime -> commands "Projects and invokes commands"
    runtime -> modelRouter "Runs model turns"
    runtime -> dolt "Reads/writes context, events, sessions, model metadata, and budget summaries"
    commands -> dolt "Reads memory and writes tool_call events"
    modelRouter -> ollama "Calls local Tier 0 model endpoint"
    modelRouter -> hostedInference "Calls paid hosted inference with explicit approval"
    runtime -> acpAgents "Runs external-agent turns over ACP stdio"
    commands -> mcpServers "Calls allowlisted MCP tools"
  }

  views {
    systemContext dyfj "SystemContext" {
      include operator
      include dyfj
      include ollama
      include hostedInference
      include acpAgents
      include mcpServers
      autolayout lr
      title "DYFJ Workbench Runtime - System Context"
      description "The operator uses the local CLI over UDS; the runtime reaches local or approved hosted inference, local ACP agents, and configured MCP servers."
    }

    container dyfj "Container" {
      include *
      autolayout lr
      title "DYFJ Workbench Runtime - Containers"
      description "The CLI is a presentation client of the UDS seam; Workbench Runtime owns turn execution and durable facts."
    }

    theme default
  }
}
