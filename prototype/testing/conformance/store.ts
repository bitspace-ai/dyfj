// Conformance suite for the `Store` port (`src/store/`).
//
// `MemoryStore` runs it in the unit lane; `DoltStore` runs it in the isolated
// Dolt integration lane, each case against its own fresh database. Both must
// agree: a fake that diverges from Dolt is a failing test
// (`specs/03-testing.md` section 5).
//
// Covered: a behavioral case for every reader method (commit -> read
// round-trip, filters, ordering, visibility scoping, spend sums); the journal
// cases (atomicity, including a failing projector; no update or delete path
// for events; every unjournaled mutation kind declared; projector
// determinism); and memory clearance for loopback, non-loopback and MCP stdio
// consumers.

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  type EventInsert,
  type EventType,
  MCP_STDIO_MEMORY_CLEARANCE,
  MEMORY_VISIBILITY_ALL,
  memoryClearanceFor,
  type MemoryStoreSeed,
  type Projector,
  type Store,
  type TextRow,
  UndeclaredMutationError,
  UNJOURNALED_MUTATION_KINDS,
  type UnjournaledMutation,
  type UnjournaledMutationKind,
} from "../../src/store/mod.ts";

export interface StoreConformanceSubject {
  name: string;
  /** A fresh, empty store holding only `seed`. */
  make(
    seed: MemoryStoreSeed,
    options?: { projectors?: readonly Projector[] },
  ): Promise<Store>;
  /** Release everything `make` created for this store. */
  dispose(store: Store): Promise<void>;
  /** Wait until the store's clock has moved past every earlier write. */
  tick(): Promise<void>;
}

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(6, "0")}`;
}

export function event(fields: Partial<EventInsert> = {}): EventInsert {
  return {
    event_id: id("EV"),
    session_id: "S1",
    event_type: "session_start",
    trace_id: "trace",
    span_id: "span",
    principal_id: "operator",
    principal_type: "human",
    action: "start",
    resource: "workbench_session",
    authz_basis: "test",
    ...fields,
  };
}

function sessionInsert(
  sessionId: string,
  fields: Partial<UnjournaledMutation & { kind: "session_insert" }> = {},
): UnjournaledMutation {
  return {
    kind: "session_insert",
    sessionId,
    slug: `slug-${sessionId}`,
    sessionName: null,
    taskDescription: `task ${sessionId}`,
    status: "active",
    mode: "interactive",
    workspace: null,
    content: null,
    progressDone: 0,
    progressTotal: 0,
    ...fields,
  } as UnjournaledMutation;
}

/** The memory rows every clearance case reads, one per visibility class. */
export const MEMORY_FIXTURE: MemoryStoreSeed["memories"] = [
  {
    memory_id: "mem_private",
    slug: "fixture_user_private",
    type: "user",
    visibility: "private",
    inject: "always",
    name: "Private User",
    description: "private row",
    content: "private content",
  },
  {
    memory_id: "mem_shareable",
    slug: "fixture_feedback_shareable",
    type: "feedback",
    visibility: "shareable",
    inject: "index",
    name: "Shareable Feedback",
    description: "shareable row",
    content: "shareable content",
  },
  {
    memory_id: "mem_client_safe",
    slug: "fixture_reference_client_safe",
    type: "reference",
    visibility: "client_safe",
    inject: "index",
    name: "Client Safe Reference",
    description: "client-safe row",
    content: "client-safe content",
  },
  {
    memory_id: "mem_public",
    slug: "fixture_project_public",
    type: "project",
    visibility: "public",
    inject: "always",
    name: "Public Project",
    description: "public row",
    content: "public content",
  },
  {
    memory_id: "mem_public_never",
    slug: "fixture_user_public_never",
    type: "user",
    visibility: "public",
    inject: "never",
    name: "Public Never",
    description: "never-injected row",
    content: "never content",
  },
];

const MODEL_FIXTURE: MemoryStoreSeed["models"] = [
  {
    slug: "zeta-local",
    display_name: "Zeta Local",
    provider: "ollama",
    api: "openai-completions",
    base_url: "http://localhost:11434/v1",
    tier: 0,
    context_window: 32768,
    max_output_tokens: 4096,
    capabilities: ["text", "code"],
    architecture: "moe",
    total_params_b: 36,
    active_params_b: 3,
    recommended_quant: "Q4_K_M",
    resident_ram_gib: 24,
  },
  {
    slug: "alpha-local",
    display_name: "Alpha Local",
    provider: "ollama",
    api: "openai-completions",
    base_url: "http://localhost:11434/v1",
    tier: 0,
    context_window: 8192,
    max_output_tokens: 2048,
    capabilities: ["text"],
  },
  {
    slug: "hosted",
    display_name: "Hosted",
    provider: "anthropic",
    api: "anthropic-messages",
    tier: 2,
    context_window: 200000,
    max_output_tokens: 8192,
    cost_input: 3,
    cost_output: 15.5,
    capabilities: ["text", "tools"],
    reasoning_effort_control: true,
  },
  {
    slug: "retired",
    display_name: "Retired",
    provider: "ollama",
    api: "openai-completions",
    tier: 0,
    context_window: 1,
    max_output_tokens: 1,
    capabilities: [],
    active: false,
  },
];

const PROMPT_FIXTURE: MemoryStoreSeed["prompts"] = [
  {
    slug: "companion-base",
    display_name: "Companion",
    kind: "base",
    content: "active prompt",
  },
  {
    slug: "retired-prompt",
    display_name: "Retired",
    kind: "base",
    content: "inactive prompt",
    active: false,
  },
];

/** A projector for tests: `session_start` upserts a session row. */
function sessionStartProjector(): Projector {
  return {
    name: "test-session-start",
    table: "sessions",
    key: (e) => e.event_type === "session_start" ? String(e.session_id) : null,
    project: (current, e) => ({
      session_id: String(e.session_id),
      slug: current?.slug || `projected-${String(e.session_id)}`,
      task_description: String(e.content ?? ""),
      status: "active",
      progress_done: Number(current?.progress_done || 0) + 1,
    }),
  };
}

function failingProjector(): Projector {
  return {
    name: "test-failing",
    table: "sessions",
    key: (e) => e.event_type === "session_start" ? String(e.session_id) : null,
    project: () => {
      throw new Error("projector failed");
    },
  };
}

function withoutTimestamps(row: TextRow | null): TextRow | null {
  if (row === null) return null;
  const { created_at: _c, updated_at: _u, ...rest } = row;
  return rest;
}

export function storeConformance(subject: StoreConformanceSubject): void {
  const run = (
    label: string,
    body: (store: Store) => Promise<void>,
    options: {
      seed?: MemoryStoreSeed;
      projectors?: readonly Projector[];
    } = {},
  ) => {
    Deno.test(`Store conformance (${subject.name}): ${label}`, async () => {
      const store = await subject.make(options.seed ?? {}, {
        projectors: options.projectors,
      });
      try {
        await body(store);
      } finally {
        await subject.dispose(store);
      }
    });
  };
  const commitEvents = (store: Store, ...events: EventInsert[]) =>
    store.journal.commit({ events });

  // ─── journal ───────────────────────────────────────────────────────────────

  run(
    "a committed event reads back, rendered as the driver renders it",
    async (store) => {
      const e = event({
        event_type: "tool_call",
        content: "hello",
        cost_total: 0.25,
        tokens_input: 42,
        tool_is_error: true,
        parent_is_remote: false,
        tool_arguments: JSON.stringify({
          zeta: 1,
          a: "x",
          nested: { bb: [1, 2], a: true },
        }),
        runner_capabilities: JSON.stringify(["text", "code"]),
        model_id: null,
      });
      const receipt = await commitEvents(store, e);
      assertEquals(receipt, { eventIds: [String(e.event_id)], mutations: 0 });
      assert(await store.events.exists(String(e.event_id)));
      assertFalse(await store.events.exists("missing"));
      assertEquals(await store.events.countBySession("S1"), 1);
      assertEquals(await store.events.countBySession("other"), 0);
      const [row] = await store.events.bySession({
        sessionId: "S1",
        limit: 10,
        order: "asc",
      });
      assert(row !== undefined);
      assertEquals(row.event_id, e.event_id);
      assertEquals(row.event_type, "tool_call");
      assertEquals(row.content, "hello");
      assertEquals(row.cost_total, "0.250000");
      assertEquals(row.tokens_input, "42");
      assertEquals(row.tool_is_error, "1");
      assertEquals(row.parent_is_remote, "0");
      assertEquals(
        row.tool_arguments,
        '{"a": "x", "zeta": 1, "nested": {"a": true, "bb": [1, 2]}}',
      );
      assertEquals(row.runner_capabilities, '["text", "code"]');
      assertEquals(row.model_id, "");
      assertEquals(row.trace_flags, "");
      assert(!Number.isNaN(Date.parse(row.created_at!)));
    },
  );

  run(
    "bySession orders, limits, filters by event and scopes to the session",
    async (store) => {
      const first = event();
      await commitEvents(store, first);
      await subject.tick();
      const second = event({ event_type: "model_response" });
      await commitEvents(store, second);
      await subject.tick();
      const third = event({ event_type: "session_end" });
      await commitEvents(store, third, event({ session_id: "S2" }));
      const ids = (rows: TextRow[]) => rows.map((r) => r.event_id);
      assertEquals(
        ids(
          await store.events.bySession({
            sessionId: "S1",
            limit: 10,
            order: "asc",
          }),
        ),
        [first.event_id, second.event_id, third.event_id],
      );
      assertEquals(
        ids(
          await store.events.bySession({
            sessionId: "S1",
            limit: 2,
            order: "desc",
          }),
        ),
        [third.event_id, second.event_id],
      );
      assertEquals(
        ids(
          await store.events.bySession({
            sessionId: "S1",
            eventId: String(second.event_id),
            limit: 10,
            order: "asc",
          }),
        ),
        [second.event_id],
      );
      assertEquals(
        await store.events.bySession({
          sessionId: "S2",
          eventId: String(second.event_id),
          limit: 10,
          order: "asc",
        }),
        [],
      );
    },
  );

  run(
    "events with the same explicit created_at order by event_id",
    async (store) => {
      const at = "2026-01-01 00:00:00.000000";
      const later = event({ event_id: "EV_TIE_B", created_at: at });
      const earlier = event({ event_id: "EV_TIE_A", created_at: at });
      // Written in the opposite order to their ids.
      await commitEvents(store, later);
      await commitEvents(store, earlier);
      const ids = async (order: "asc" | "desc") =>
        (await store.events.bySession({ sessionId: "S1", limit: 10, order }))
          .map((r) => r.event_id);
      assertEquals(await ids("asc"), ["EV_TIE_A", "EV_TIE_B"]);
      assertEquals(await ids("desc"), ["EV_TIE_B", "EV_TIE_A"]);
    },
  );

  run(
    "bySession rejects a malformed asOf and a non-positive limit",
    async (store) => {
      await assertRejects(
        () =>
          store.events.bySession({
            sessionId: "S1",
            asOf: "yesterday'); DROP TABLE events; --",
            limit: 10,
            order: "asc",
          }),
        Error,
        "asOf must be a timestamp",
      );
      await assertRejects(
        () =>
          store.events.bySession({ sessionId: "S1", limit: 0, order: "asc" }),
        Error,
        "limit must be a positive integer",
      );
    },
  );

  run("a batch is atomic: one invalid event writes nothing", async (store) => {
    const good = event();
    // Deliberately invalid: an event without its NOT NULL trace_id.
    const { trace_id: _omitted, ...bad } = event();
    await assertRejects(() => commitEvents(store, good, bad as EventInsert));
    assertFalse(await store.events.exists(String(good.event_id)));
    assertEquals(await store.events.countBySession("S1"), 0);
  });

  run(
    "a batch is atomic: a failing mutation rolls back its events",
    async (store) => {
      await store.journal.commit({
        events: [],
        mutations: [sessionInsert("A")],
      });
      const e = event({ session_id: "B" });
      await assertRejects(() =>
        store.journal.commit({
          events: [e],
          // Same slug as A: a unique-key violation.
          mutations: [sessionInsert("B", { slug: "slug-A" })],
        })
      );
      assertFalse(await store.events.exists(String(e.event_id)));
      assertStrictEquals(await store.sessions.summary("B"), null);
    },
  );

  run(
    "a failing projector leaves neither the event nor the projection changed",
    async (store) => {
      await store.journal.commit({
        events: [],
        mutations: [sessionInsert("S1")],
      });
      const before = await store.sessions.summary("S1");
      const e = event({ content: "never projected" });
      await assertRejects(
        () => commitEvents(store, e),
        Error,
        "projector failed",
      );
      assertFalse(await store.events.exists(String(e.event_id)));
      assertEquals(await store.sessions.summary("S1"), before);
    },
    { projectors: [failingProjector()] },
  );

  run(
    "projectors apply in the commit and create, then update, their row",
    async (store) => {
      await commitEvents(store, event({ content: "first" }));
      const created = await store.sessions.summary("S1");
      assertEquals(created?.slug, "projected-S1");
      assertEquals(created?.task_description, "first");
      await commitEvents(store, event({ content: "second" }));
      const detail = await store.sessions.detail({ sessionId: "S1" });
      assertEquals(detail?.task_description, "second");
      assertEquals(detail?.progress_done, "2");
      // An event the projector does not select leaves the table alone.
      await commitEvents(
        store,
        event({ session_id: "S9", event_type: "error" }),
      );
      assertStrictEquals(await store.sessions.summary("S9"), null);
    },
    { projectors: [sessionStartProjector()] },
  );

  Deno.test(
    `Store conformance (${subject.name}): projectors are deterministic: the same events give the same rows`,
    async () => {
      const events = [
        event({ session_id: "D1", content: "one" }),
        event({ session_id: "D2", content: "two" }),
        event({ session_id: "D1", content: "three" }),
      ];
      const project = async () => {
        const store = await subject.make({}, {
          projectors: [sessionStartProjector()],
        });
        try {
          for (const e of events) await commitEvents(store, e);
          return [
            withoutTimestamps(await store.sessions.detail({ sessionId: "D1" })),
            withoutTimestamps(await store.sessions.detail({ sessionId: "D2" })),
          ];
        } finally {
          await subject.dispose(store);
        }
      };
      const first = await project();
      assertNotEquals(first[0], null);
      assertEquals(await project(), first);
    },
  );

  run("the events table has no update or delete path", async (store) => {
    // The mutation surface is `journal.commit` and nothing else, and the event
    // reader only reads.
    assertEquals(Object.keys(store.journal).filter((k) => k !== "commit"), []);
    assertEquals(
      Object.keys(store.events).sort(),
      ["bySession", "countBySession", "exists"],
    );
    // Appending an existing event id is rejected, not an overwrite.
    const original = event({ content: "original" });
    await commitEvents(store, original);
    await assertRejects(() =>
      commitEvents(store, { ...original, content: "rewritten" })
    );
    const rows = await store.events.bySession({
      sessionId: "S1",
      limit: 10,
      order: "asc",
    });
    assertEquals(rows.map((r) => r.content), ["original"]);
  });

  run(
    "an undeclared mutation kind is rejected and nothing is written",
    async (store) => {
      const e = event();
      await assertRejects(
        () =>
          store.journal.commit({
            events: [e],
            mutations: [
              {
                kind: "session_delete",
                sessionId: "S1",
              } as unknown as UnjournaledMutation,
            ],
          }),
        UndeclaredMutationError,
      );
      assertFalse(await store.events.exists(String(e.event_id)));
    },
  );

  run(
    "an aborted commit rejects even when the batch is empty",
    async (store) => {
      const controller = new AbortController();
      controller.abort();
      const error = await assertRejects(() =>
        store.journal.commit({ events: [] }, { signal: controller.signal })
      );
      assertEquals((error as Error).name, "AbortError");
    },
  );

  run("an aborted commit writes nothing", async (store) => {
    const controller = new AbortController();
    controller.abort();
    const e = event();
    const error = await assertRejects(() =>
      store.journal.commit({ events: [e] }, { signal: controller.signal })
    );
    assertEquals((error as Error).name, "AbortError");
    assertFalse(await store.events.exists(String(e.event_id)));
  });

  // Each declared kind has a case below; a new kind fails here until it does.
  const exercised: Record<UnjournaledMutationKind, true> = {
    session_insert: true,
    session_update: true,
    memory_upsert: true,
  };
  Deno.test(
    `Store conformance (${subject.name}): every declared mutation kind is exercised`,
    () => {
      assertEquals(
        Object.keys(UNJOURNALED_MUTATION_KINDS).sort(),
        Object.keys(exercised).sort(),
      );
      for (const reason of Object.values(UNJOURNALED_MUTATION_KINDS)) {
        assert(reason.length > 0);
      }
    },
  );

  // ─── sessions ──────────────────────────────────────────────────────────────

  run("session_insert and the session readers round-trip", async (store) => {
    await store.journal.commit({
      events: [],
      mutations: [
        sessionInsert("A", {
          sessionName: "Name A",
          workspace: "/work/a",
          content: "content A",
        }),
      ],
    });
    await subject.tick();
    await store.journal.commit({
      events: [],
      mutations: [
        sessionInsert("B", {
          status: "completed",
          progressDone: 2,
          progressTotal: 3,
        }),
      ],
    });
    assertEquals(await store.sessions.workspace("A"), { workspace: "/work/a" });
    assertEquals(await store.sessions.workspace("B"), { workspace: "" });
    assertStrictEquals(await store.sessions.workspace("missing"), null);
    const summary = await store.sessions.summary("A");
    assertEquals(withoutTimestamps(summary), {
      session_id: "A",
      slug: "slug-A",
      session_name: "Name A",
      task_description: "task A",
      project: "",
      status: "active",
    });
    assert(!Number.isNaN(Date.parse(summary!.created_at!)));
    assertStrictEquals(await store.sessions.summary("missing"), null);
    assertEquals(
      (await store.sessions.list({ limit: 10 })).map((r) => r.session_id),
      ["B", "A"],
    );
    assertEquals(
      (await store.sessions.list({ limit: 1 })).map((r) => r.session_id),
      ["B"],
    );
    assertEquals(
      await store.sessions.list({ project: "elsewhere", limit: 10 }),
      [],
    );
    assertEquals(
      (await store.sessions.recent({ limit: 10 })).map((r) => r.session_id),
      ["B", "A"],
    );
    const completed = await store.sessions.recent({
      status: "completed",
      limit: 10,
    });
    assertEquals(
      completed.map((r) => [r.session_id, r.progress_done, r.progress_total]),
      [
        ["B", "2", "3"],
      ],
    );
    for (const limit of [0, -1, 1.5]) {
      await assertRejects(
        () => store.sessions.list({ limit }),
        Error,
        "limit must be a positive integer",
      );
      await assertRejects(
        () => store.sessions.recent({ limit }),
        Error,
        "limit must be a positive integer",
      );
    }
    const bySlug = await store.sessions.detail({ slug: "slug-A" });
    assertEquals(bySlug?.session_id, "A");
    assertEquals(bySlug?.mode, "interactive");
    assertEquals(bySlug?.effort_level, "");
    assertEquals(bySlug?.content, "content A");
    assertStrictEquals(
      await store.sessions.detail({ sessionId: "missing" }),
      null,
    );
  });

  run(
    "session_update sets status and progress, keeps content on null, and moves activity",
    async (store) => {
      await store.journal.commit({
        events: [],
        mutations: [
          sessionInsert("A", { content: "kept" }),
          sessionInsert("B"),
        ],
      });
      await subject.tick();
      await store.journal.commit({
        events: [],
        mutations: [{
          kind: "session_update",
          sessionId: "A",
          status: "completed",
          progressDone: 1,
          progressTotal: 1,
          content: null,
        }],
      });
      const a = await store.sessions.detail({ sessionId: "A" });
      assertEquals(
        [a?.status, a?.progress_done, a?.progress_total, a?.content],
        [
          "completed",
          "1",
          "1",
          "kept",
        ],
      );
      assertEquals(
        (await store.sessions.list({ limit: 10 })).map((r) => r.session_id),
        ["A", "B"],
      );
      await store.journal.commit({
        events: [],
        mutations: [{
          kind: "session_update",
          sessionId: "A",
          status: "completed",
          progressDone: 1,
          progressTotal: 1,
          content: "replaced",
        }],
      });
      assertEquals(
        (await store.sessions.detail({ sessionId: "A" }))?.content,
        "replaced",
      );
      // Updating a session that does not exist changes nothing.
      await store.journal.commit({
        events: [],
        mutations: [{
          kind: "session_update",
          sessionId: "missing",
          status: "active",
          progressDone: 0,
          progressTotal: 0,
          content: null,
        }],
      });
      assertStrictEquals(await store.sessions.summary("missing"), null);
    },
  );

  // ─── memories and clearance ────────────────────────────────────────────────

  const memorySeed = { memories: MEMORY_FIXTURE };
  const slugs = (rows: TextRow[]) => rows.map((r) => r.slug);

  run("loopback clearance reads every visibility class", async (store) => {
    const clearance = memoryClearanceFor("loopback");
    assertEquals(clearance, [...MEMORY_VISIBILITY_ALL]);
    // ORDER BY type follows the ENUM declaration (user, feedback, ..., project,
    // reference), not the alphabet.
    assertEquals(slugs(await store.memories.injected(clearance)), [
      "fixture_user_private",
      "fixture_project_public",
    ]);
    assertEquals(slugs(await store.memories.indexed(clearance)), [
      "fixture_feedback_shareable",
      "fixture_reference_client_safe",
    ]);
    const injected = await store.memories.injected(clearance);
    assertEquals(injected[0], {
      memory_id: "mem_private",
      slug: "fixture_user_private",
      type: "user",
      name: "Private User",
      description: "private row",
      content: "private content",
    });
    const indexed = await store.memories.indexed(clearance);
    assertFalse("content" in indexed[0]!);
    assertEquals(
      (await store.memories.bySlug("fixture_user_private", clearance))?.content,
      "private content",
    );
    assertEquals(slugs(await store.memories.list(clearance)), [
      "fixture_user_private",
      "fixture_user_public_never",
      "fixture_feedback_shareable",
      "fixture_project_public",
      "fixture_reference_client_safe",
    ]);
  }, { seed: memorySeed });

  run(
    "non-loopback clearance reads only client-safe and public rows",
    async (store) => {
      const clearance = memoryClearanceFor("remote");
      assertEquals(clearance, ["client_safe", "public"]);
      assertEquals(slugs(await store.memories.injected(clearance)), [
        "fixture_project_public",
      ]);
      assertEquals(slugs(await store.memories.indexed(clearance)), [
        "fixture_reference_client_safe",
      ]);
      assertStrictEquals(
        await store.memories.bySlug("fixture_user_private", clearance),
        null,
      );
      assertStrictEquals(
        await store.memories.bySlug("fixture_feedback_shareable", clearance),
        null,
      );
    },
    { seed: memorySeed },
  );

  run(
    "MCP stdio clearance lists and reads only client-safe and public rows",
    async (store) => {
      const clearance = MCP_STDIO_MEMORY_CLEARANCE;
      assertEquals([...clearance], ["client_safe", "public"]);
      assertEquals(slugs(await store.memories.list(clearance)), [
        "fixture_user_public_never",
        "fixture_project_public",
        "fixture_reference_client_safe",
      ]);
      assertEquals(
        slugs(await store.memories.list(clearance, { type: "project" })),
        ["fixture_project_public"],
      );
      assertEquals(
        await store.memories.list(clearance, { type: "feedback" }),
        [],
      );
      assertEquals(
        (await store.memories.bySlug("fixture_project_public", clearance))
          ?.content,
        "public content",
      );
      assertStrictEquals(
        await store.memories.bySlug("fixture_user_private", clearance),
        null,
      );
      assertStrictEquals(
        await store.memories.bySlug("' OR '1'='1", clearance),
        null,
      );
    },
    { seed: memorySeed },
  );

  run("an empty clearance reads nothing", async (store) => {
    assertEquals(await store.memories.injected([]), []);
    assertEquals(await store.memories.indexed([]), []);
    assertEquals(await store.memories.list([]), []);
    assertStrictEquals(
      await store.memories.bySlug("fixture_project_public", []),
      null,
    );
  }, { seed: memorySeed });

  run(
    "memory_upsert inserts a private index row, then replaces only its text",
    async (store) => {
      const upsert = (fields: Record<string, string>): UnjournaledMutation => ({
        kind: "memory_upsert",
        memoryId: id("MEM"),
        slug: "written",
        type: "project",
        name: "Written",
        description: "first",
        content: "first content",
        ...fields,
      } as UnjournaledMutation);
      await store.journal.commit({ events: [], mutations: [upsert({})] });
      const remote = memoryClearanceFor("remote");
      const all = memoryClearanceFor("loopback");
      assertStrictEquals(await store.memories.bySlug("written", remote), null);
      assertEquals(slugs(await store.memories.indexed(all)), ["written"]);
      const first = await store.memories.bySlug("written", all);
      await store.journal.commit({
        events: [],
        mutations: [upsert({
          type: "reference",
          name: "Renamed",
          description: "second",
          content: "second content",
        })],
      });
      const second = await store.memories.bySlug("written", all);
      assertEquals(second, {
        memory_id: first!.memory_id,
        slug: "written",
        type: "project",
        name: "Renamed",
        description: "second",
        content: "second content",
      });
    },
  );

  // ─── reference data and spend ──────────────────────────────────────────────

  run(
    "models.listActive returns active rows by tier then slug",
    async (store) => {
      const rows = await store.models.listActive();
      assertEquals(rows.map((r) => r.slug), [
        "alpha-local",
        "zeta-local",
        "hosted",
      ]);
      assertEquals(rows[1], {
        slug: "zeta-local",
        display_name: "Zeta Local",
        provider: "ollama",
        api: "openai-completions",
        base_url: "http://localhost:11434/v1",
        tier: "0",
        cost_input: "0.000000",
        cost_output: "0.000000",
        capabilities: "text,code",
        context_window: "32768",
        max_output_tokens: "4096",
        architecture: "moe",
        total_params_b: "36.00",
        active_params_b: "3.00",
        recommended_quant: "Q4_K_M",
        resident_ram_gib: "24.00",
        reasoning_effort_control: "0",
      });
      assertEquals(
        [
          rows[2]!.cost_output,
          rows[2]!.base_url,
          rows[2]!.reasoning_effort_control,
        ],
        ["15.500000", "", "1"],
      );
    },
    { seed: { models: MODEL_FIXTURE } },
  );

  run("prompts.active reads an active prompt by slug", async (store) => {
    assertEquals(await store.prompts.active("companion-base"), {
      content: "active prompt",
    });
    assertStrictEquals(await store.prompts.active("retired-prompt"), null);
    assertStrictEquals(await store.prompts.active("missing"), null);
  }, { seed: { prompts: PROMPT_FIXTURE } });

  run(
    "spend baselines sum model_response costs by session and day",
    async (store) => {
      const cost = (
        sessionId: string,
        cost_total: number | null,
        event_type: EventType = "model_response",
      ) => event({ session_id: sessionId, event_type, cost_total });
      await commitEvents(
        store,
        cost("S1", 0.5),
        cost("S1", 0.25),
        cost("S2", 1.125),
        cost("S3", 2),
        cost("S1", 0),
        cost("S1", null),
        cost("S1", 9, "budget_summary"),
      );
      // Every write is after a day that started in the past.
      assertEquals(await store.spend.baselines("S1", "2000-01-01 00:00:00"), {
        sessionSpentUsd: 0.75,
        sessionSpentTodayUsd: 0.75,
        dailyOtherSessionsUsd: 3.125,
      });
      // A day that starts in the future has no spend yet.
      assertEquals(await store.spend.baselines("S1", "2999-01-01 00:00:00"), {
        sessionSpentUsd: 0.75,
        sessionSpentTodayUsd: 0,
        dailyOtherSessionsUsd: 0,
      });
      assertEquals(await store.spend.baselines("none", "2000-01-01 00:00:00"), {
        sessionSpentUsd: 0,
        sessionSpentTodayUsd: 0,
        dailyOtherSessionsUsd: 3.875,
      });
    },
  );
}
