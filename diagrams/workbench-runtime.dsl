workspace "DYFJ Workbench Runtime" "C4 views for the Workbench runtime and its CLI/HTTP veneers." {
  model {
    operator = person "Operator" "Runs local Workbench turns from CLI, shell, or local HTTP."
    ollama = softwareSystem "Ollama" "External local model runtime used for Tier 0 inference."
    hostedInference = softwareSystem "Hosted Model APIs" "External paid inference endpoints used only through explicit escalation."

    dyfj = softwareSystem "DYFJ" "Local-first AI workbench and automation framework." {
      cli = container "Workbench CLI and Shell" "Parses command-line input, runs the interactive shell loop, renders text output and receipts." "Deno / TypeScript"
      http = container "Local HTTP Veneer" "Exposes a minimal local HTML surface and JSON turn route." "Deno.serve / TypeScript"
      runtime = container "Workbench Runtime" "Executes one Workbench turn: context loading, model routing, command/tool calls, events, sessions, budgets, and receipt facts." "TypeScript"
      commands = container "Command Registry" "Projects bounded commands as model tools and executes policy-checked command calls." "TypeScript"
      modelRouter = container "Provider Path" "Selects a model, shapes OpenAI-compatible requests, parses responses, tool calls, timings, usage, and cost." "TypeScript"
      dolt = container "Dolt Data Store" "Canonical schema, events, sessions, memories, model registry, and budget/event records." "Dolt SQL"
    }

    operator -> cli "Runs prompts and shell commands"
    operator -> http "Uses browser, text browser, or local HTTP client"
    cli -> runtime "Invokes single-turn runtime"
    http -> runtime "Invokes single-turn runtime"
    runtime -> commands "Projects and invokes commands"
    runtime -> modelRouter "Runs model turns"
    runtime -> dolt "Reads/writes context, events, sessions, model metadata, and budget summaries"
    commands -> dolt "Reads memory and writes tool_call events"
    modelRouter -> ollama "Calls local Tier 0 model endpoint"
    modelRouter -> hostedInference "Escalates to paid hosted inference with explicit consent"
  }

  views {
    systemContext dyfj "SystemContext" {
      include operator
      include dyfj
      include ollama
      include hostedInference
      autolayout lr
      title "DYFJ Workbench Runtime - System Context"
      description "The operator uses local CLI/shell or local HTTP veneers over DYFJ, which depends on local-first model inference and optional explicit hosted escalation."
    }

    container dyfj "Container" {
      include *
      autolayout lr
      title "DYFJ Workbench Runtime - Containers"
      description "CLI and HTTP are presentation veneers; Workbench Runtime owns turn execution and durable facts."
    }

    theme default
  }
}
