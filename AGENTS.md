# AGENTS.md for DYFJ Workbench

## Project Name
DYFJ (Do Your Fucking Job) Workbench

## Origin and Attribution

DYFJ is heavily inspired by [Daniel Miessler's](https://danielmiessler.com) open-source
[Personal AI Infrastructure (PAI)](https://github.com/danielmiessler/PAI) project.
The Algorithm methodology, skill/workflow architecture, and the broader vision of a
personally-owned AI stack all trace directly to his work and thinking.

The primary divergence: PAI is built on Claude Code (Anthropic-proprietary runtime).
DYFJ ports those ideas onto vendor-agnostic infrastructure — pi-ai for model routing,
Dolt for persistence, and a native desktop UI — so the stack is owned, not rented.

## Purpose
The DYFJ Workbench is a personal, vendor-agnostic AI workbench. Its primary goal is to
grant the user full ownership and control over their AI tools and workflows.

## Key Objectives (MVP)
The project's Minimum Viable Product (MVP) is built upon three foundational pillars:
1.  **Dolt Integration:** Transition from markdown-file based persistence to a SQL database with Git-like versioning capabilities.
2.  **Native Desktop UI:** Replace the current terminal-based interface with a native desktop application. Tauri is the likely vehicle — not certain yet, but the direction is clear: native, not Electron, not a web wrapper.
3.  **Vendor-Agnostic Model Routing:** Establish a flexible system that defaults to local AI models (e.g., Ollama) and requires explicit escalation for calls to external API-based models, emphasizing cost discipline.

## Architecture Overview
The system follows this high-level flow:
`User ↔ Workbench UI (Tauri, future) ↔ pi-ai (model abstraction) ↔ Models (Ollama, APIs)`
`                                         ↕`
`                                     Dolt (persistence)`

-   **pi-ai (`@mariozechner/pi-ai`):** Serves as the central model abstraction layer, handling interactions with various AI providers.
-   **Dolt:** Acts as the persistent data store, offering SQL-compatible (MySQL 8.0 dialect) capabilities with Git semantics (branching, committing, diffing, time-travel).
-   **Native UI (likely Tauri):** The future desktop layer. Stack TBD beyond Rust at the core.

## Data Model (Dolt Schema)
The Dolt database, located at `data/dolt/`, implements a schema (DDL at `schema/*.sql`):
1.  **`events`:** Captures runtime telemetry (model calls, tool usage, errors) with built-in OTel correlation (trace_id, span_id) and security audit fields (principal_id, authz_basis).
2.  **`memories`:** Stores durable context (user profiles, feedback, project state, references). Includes structured metadata (name, type, description) and freeform `TEXT` content for model interpretation.
3.  **`sessions`:** Represents units of work, containing structured metadata (task, effort_level, phase, progress) and freeform `TEXT` for detailed context, criteria, decisions, and verification.
4.  **`reflections`:** Holds structured learning data (criteria pass rates, sentiment, budget compliance) for aggregate analysis.

## Core Design Principles
-   **Thorough Testing, Evals, and Validations:** Implement robust testing at all levels, including unit, integration, and end-to-end tests, alongside model evaluations and data validations.
-   **Data-Layer Schema:** Dolt DDL is the source of truth for the schema; TypeScript types are derived.
-   **Flexible Persistence:** Dolt serves as a structured filing cabinet, not a rigid constraint. Structured metadata aids filtering, while freeform text allows model interpretation.
-   **Embrace Non-Determinism:** The value lies in the model's emergent reasoning; persistence makes artifacts durable.
-   **Local Models First:** Ollama is the default; API calls require explicit consent to manage costs.
-   **Integrated Observability & Security:** OTel (trace/span IDs) and security audit (principal_id/authz_basis) are foundational for `events`.
-   **Time-Sortable IDs:** Primary keys use ULID or UUIDv7 for efficient sequential inserts in Dolt.
-   **Minimal Indexing:** Only index what is actively queried to optimize Dolt's prolly-tree performance.

## Current Project State
-   Dolt database initialized with the 4-table schema.
-   Full model router with 3-tier consent and cost-aware routing (`src/router.ts`)
-   Session-start memory retrieval from Dolt via pi extension (`.pi/extensions/dyfj-memory.ts`)
-   Notion → Dolt task sync (`scripts/sync-tasks.ts`)

## Language Philosophy

Language choices are deliberate, not fashionable:

-   **Rust** for anything close to the metal — agent runtimes, system integration, performance-sensitive paths. The key reason is not memory safety or speed (though both matter) — it is that Rust is exceptionally explicit when code is wrong. When an agent writes broken Rust, the compiler says exactly why. That property is a force multiplier in AI-assisted development.
-   **TypeScript** for UI, DOM manipulation, and scripty glue. Strong typing catches agent errors at the boundary between intent and execution, without the weight of a systems language.
-   **SQL (Dolt)** as the data contract layer. Schema lives in DDL, not in application code.

## Runtime Environment & Conventions
-   **Runtime:** Bun (not Node.js).
-   **Testing Framework:** Bun's built-in test runner.
-   **Running Tests:** From the project root (`~/.dyfj/`), run `bun test` to execute all tests, or `bun test src/<file_pattern>` for specific test files.
-   **Dolt Binary:** `/opt/homebrew/bin/dolt`
-   **Dolt Database Location:** `~/.dyfj/data/dolt/`
-   **Ollama Endpoint:** `http://localhost:11434`
-   **Default Local Model:** `gemma4` (27B)

## Important Constraints & Anti-Patterns
-   **NO expensive API models** without explicit permission.
-   **DO NOT add OTel SDK dependencies;** trace/span IDs are plain strings.
-   **DO NOT build a full RBAC engine;** log principal+action+resource, defer policy derivation.
-   **DO NOT normalize the schema further;** the wide-table design is intentional.
-   **DO NOT build UI yet;** focus solely on getting data flowing into Dolt first.

## Agent Interaction Guidelines
-   **Prioritize the "Tracer Bullet" task:** Focus all efforts on wiring `pi-ai` stream events to the Dolt `events` table until this is demonstrably complete.
-   **Adhere to Constraints:** Before proposing or implementing any solution, verify it strictly complies with the "Important Constraints & Anti-Patterns" section.
-   **Confirm Model Usage:** If a task requires an external API model, explicitly notify the user and obtain approval due to potential costs. Default to local models (`gemma4`) where feasible.
-   **Respect Project Phasing:** Concentrates on backend data flow and persistence (Dolt integration). Native UI development is deferred until later stages.
-   **Follow Runtime Conventions:** Ensure all proposed commands and code snippets are compatible with the Bun runtime and specified environment paths.
