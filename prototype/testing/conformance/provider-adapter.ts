// The provider conformance kit (`specs/03-testing.md` section 5).
//
// Every `ProviderAdapter` runs this kit with recorded fixtures: for each case,
// the requests it must send (assertions at the `HttpTransport` port) and the
// responses the provider sent back. The kit drives each fixture through a
// registry holding only the adapter under test, so selection, the
// pre-dispatch abort check, base-URL validation and abort recovery run exactly
// as in production, and asserts the `WorkbenchTurnResult` and the text frames
// the adapter emitted.
//
// Fixture cases (all required): plain text, native tool calls, text-markup
// tool calls, usage and cost, a length stop, a mid-stream error, an abort,
// and a base-URL rejection. An adapter that does not support a case still
// supplies the fixture and pins what it does instead: an adapter that never
// returns tool calls pins `toolCalls: undefined`. The kit derives two more
// cases from the plain-text fixture: the header deadline in both request
// modes, and an abort observed before dispatch.
//
// Invariants the kit adds to every fixture: every scripted exchange is used;
// a streamed turn's frames concatenate to its result text, so live output and
// the durable text agree; and each case's defining property (for example a
// base-URL rejection sends no request).

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertObjectMatch,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  createProviderRegistry,
  PROVIDER_BUFFERED_HEADER_TIMEOUT_MS,
  PROVIDER_HEADER_TIMEOUT_MS,
  type ProviderAdapter,
  type WorkbenchModel,
  type WorkbenchTurnParams,
  type WorkbenchTurnResult,
} from "../../src/providers/mod.ts";
import { ManualClock } from "../fakes/manual-clock.ts";
import { MapEnv } from "../fakes/map-env.ts";
import {
  type ScriptedExchange,
  ScriptedHttpTransport,
} from "../fakes/scripted-http-transport.ts";

/** The conversation fields a fixture may set; the rest are the kit's. */
export type KitTurn = Partial<
  Pick<
    WorkbenchTurnParams,
    | "systemPrompt"
    | "prompt"
    | "messages"
    | "tools"
    | "historyTools"
    | "jsonObject"
    | "maxOutputTokens"
    | "sessionId"
  >
>;

export type KitExpectation =
  | {
    /** Matched as a subset; keys set to `undefined` must be absent or undefined. */
    result: Record<string, unknown>;
    /** The exact text frames, when the fixture pins them. */
    frames?: string[];
  }
  | {
    error: {
      /** The error class the turn must reject with. */
      instance?: abstract new (...args: never[]) => Error;
      message?: string | RegExp;
    };
  };

export interface KitFixture {
  model: WorkbenchModel;
  turn?: KitTurn;
  /** The process environment the adapter reads (credentials). */
  env?: Record<string, string>;
  /** Whether the turn streams (the caller takes text frames). */
  stream: boolean;
  /** Request assertions and recorded responses, in order. */
  exchanges: ScriptedExchange[];
  /** Clock readings, in order; the clock stays at the last one. */
  clock?: number[];
  /** Abort the turn once this many frames have arrived. */
  abortAfterFrames?: number;
  expect: KitExpectation;
}

export interface ProviderKitFixtures {
  plainText: KitFixture;
  nativeToolCalls: KitFixture;
  textMarkupToolCalls: KitFixture;
  usage: KitFixture;
  lengthStop: KitFixture;
  midStreamError: KitFixture;
  abort: KitFixture;
  baseUrlRejection: KitFixture;
}

export interface ProviderKitSubject {
  name: string;
  adapter: ProviderAdapter;
  fixtures: ProviderKitFixtures;
}

interface KitRun {
  result?: WorkbenchTurnResult;
  error?: unknown;
  frames: string[];
  transport: ScriptedHttpTransport;
}

function turnParams(
  fixture: Pick<KitFixture, "model" | "turn" | "env">,
  transport: ScriptedHttpTransport,
  clock: ManualClock,
  signal: AbortSignal,
  onTextDelta: ((delta: string) => void) | undefined,
): WorkbenchTurnParams {
  const env = new MapEnv(fixture.env ?? {});
  return {
    systemPrompt: "system",
    prompt: "hello",
    ...fixture.turn,
    routing: { modelId: fixture.model.slug },
    models: [fixture.model],
    fetchFn: transport.fetch,
    now: clock.now,
    getEnv: (name) => env.get(name),
    abortSignal: signal,
    ...(onTextDelta === undefined ? {} : { onTextDelta }),
  };
}

/** Run one fixture through a registry holding only `adapter`. */
export async function runKitFixture(
  adapter: ProviderAdapter,
  fixture: KitFixture,
): Promise<KitRun> {
  const transport = new ScriptedHttpTransport(fixture.exchanges);
  const clock = new ManualClock({ readings: fixture.clock ?? [] });
  const controller = new AbortController();
  const frames: string[] = [];
  let reached: () => void = () => {};
  const reachedAbortPoint = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const onTextDelta = fixture.stream
    ? (delta: string) => {
      frames.push(delta);
      if (frames.length === fixture.abortAfterFrames) reached();
    }
    : undefined;
  const registry = createProviderRegistry([adapter]);
  const pending = registry.runWorkbenchTurn(
    turnParams(fixture, transport, clock, controller.signal, onTextDelta),
  );
  if (fixture.abortAfterFrames !== undefined) {
    await Promise.race([reachedAbortPoint, pending.catch(() => {})]);
    controller.abort();
  }
  try {
    return { result: await pending, frames, transport };
  } catch (error) {
    return { error, frames, transport };
  }
}

/** Assert `result` matches `expected`, treating `undefined` values as absent. */
export function assertResultMatches(
  result: WorkbenchTurnResult,
  expected: Record<string, unknown>,
): void {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) {
      assertStrictEquals(
        (result as unknown as Record<string, unknown>)[key],
        undefined,
        `result.${key} should be undefined`,
      );
    } else {
      defined[key] = value;
    }
  }
  assertObjectMatch(result as unknown as Record<string, unknown>, defined);
}

function assertExpectation(run: KitRun, fixture: KitFixture): void {
  const expected = fixture.expect;
  if ("error" in expected) {
    assert(
      run.error !== undefined,
      `expected the turn to fail, but it resolved: ${
        JSON.stringify(run.result)
      }`,
    );
    if (expected.error.instance) {
      assertInstanceOf(run.error, expected.error.instance);
    }
    if (expected.error.message !== undefined) {
      const message = (run.error as Error).message;
      if (typeof expected.error.message === "string") {
        assertStringIncludes(message, expected.error.message);
      } else {
        assertMatch(message, expected.error.message);
      }
    }
    return;
  }
  if (run.error !== undefined) throw run.error;
  const result = run.result!;
  assertResultMatches(result, expected.result);
  if (expected.frames !== undefined) assertEquals(run.frames, expected.frames);
  if (fixture.stream) {
    assertEquals(
      run.frames.join(""),
      result.text,
      "live frames and the durable text diverged",
    );
  } else {
    assertEquals(run.frames, [], "a buffered turn emitted frames");
  }
}

function resultOf(run: KitRun): WorkbenchTurnResult {
  if (run.error !== undefined) throw run.error;
  return run.result!;
}

export function providerAdapterConformance(subject: ProviderKitSubject): void {
  const { adapter, fixtures } = subject;
  const label = (name: string) =>
    `provider conformance (${subject.name}): ${name}`;

  const caseTest = (
    name: string,
    fixture: KitFixture,
    extra: (run: KitRun) => void = () => {},
  ) => {
    Deno.test(label(name), async () => {
      const run = await runKitFixture(adapter, fixture);
      assertExpectation(run, fixture);
      extra(run);
      run.transport.assertDone();
    });
  };

  caseTest("plain text", fixtures.plainText, (run) => {
    assert(fixtures.plainText.stream, "the plain-text fixture must stream");
    const result = resultOf(run);
    assertEquals(result.stopReason, "stop");
    assertStrictEquals(result.toolCalls, undefined);
    assert(run.frames.length > 0, "a streamed plain-text turn emits frames");
  });

  caseTest("native tool calls", fixtures.nativeToolCalls, (run) => {
    const expected = fixtures.nativeToolCalls.expect;
    assert(
      "result" in expected && "toolCalls" in expected.result,
      "the native tool-call fixture must pin toolCalls",
    );
    resultOf(run);
  });

  caseTest("text-markup tool calls", fixtures.textMarkupToolCalls, (run) => {
    const expected = fixtures.textMarkupToolCalls.expect;
    assert(
      "result" in expected && "toolCalls" in expected.result,
      "the text-markup fixture must pin toolCalls",
    );
    assert(
      (fixtures.textMarkupToolCalls.turn?.tools?.length ?? 0) > 0,
      "the text-markup fixture must offer tools",
    );
    resultOf(run);
  });

  caseTest("usage and cost", fixtures.usage, (run) => {
    const expected = fixtures.usage.expect;
    assert(
      "result" in expected && "usage" in expected.result,
      "the usage fixture must pin usage",
    );
    // Usage is pinned exactly, not as a subset.
    assertEquals(resultOf(run).usage, expected.result.usage);
  });

  caseTest("length stop", fixtures.lengthStop, (run) => {
    assertEquals(resultOf(run).stopReason, "length");
  });

  caseTest("mid-stream error", fixtures.midStreamError, (run) => {
    assert(fixtures.midStreamError.stream, "the error must arrive mid-stream");
    assert("error" in fixtures.midStreamError.expect);
    assert(run.error !== undefined);
  });

  caseTest("abort", fixtures.abort, (run) => {
    assert(
      fixtures.abort.abortAfterFrames !== undefined,
      "the abort fixture must abort after a frame",
    );
    const result = resultOf(run);
    assertEquals(result.stopReason, "aborted");
    assertStrictEquals(result.toolCalls, undefined);
  });

  caseTest("base-URL rejection", fixtures.baseUrlRejection, (run) => {
    assert(
      !adapter.validateBaseUrl(fixtures.baseUrlRejection.model).ok,
      "validateBaseUrl must reject the fixture's model",
    );
    assert("error" in fixtures.baseUrlRejection.expect);
    assertEquals(run.transport.requests.length, 0, "a request was sent");
  });

  Deno.test(label("the plain-text model passes validateBaseUrl"), () => {
    assert(adapter.validateBaseUrl(fixtures.plainText.model).ok);
    assert(adapter.providers.has(fixtures.plainText.model.provider));
  });

  Deno.test(label("an abort before dispatch sends nothing"), async () => {
    const transport = new ScriptedHttpTransport();
    const controller = new AbortController();
    controller.abort();
    const result = await createProviderRegistry([adapter]).runWorkbenchTurn(
      turnParams(
        fixtures.plainText,
        transport,
        new ManualClock(),
        controller.signal,
        () => {},
      ),
    );
    assertResultMatches(result, {
      text: "",
      stopReason: "aborted",
      requestDispatched: false,
    });
    assertEquals(result.usage.input, 0);
    assertEquals(transport.requests.length, 0);
  });

  const deadlineTest = (stream: boolean) => {
    const budget = stream
      ? PROVIDER_HEADER_TIMEOUT_MS
      : PROVIDER_BUFFERED_HEADER_TIMEOUT_MS;
    const mode = stream ? "streaming" : "buffered";
    Deno.test(
      label(`a ${mode} request fails at its header deadline`),
      async () => {
        using time = new FakeTime();
        const transport = new ScriptedHttpTransport([{
          respond: { withholdHeaders: true },
        }]);
        let settled = false;
        const turn = createProviderRegistry([adapter]).runWorkbenchTurn(
          turnParams(
            fixtures.plainText,
            transport,
            new ManualClock(),
            new AbortController().signal,
            stream ? () => {} : undefined,
          ),
        );
        const outcome = turn.then(
          () => undefined,
          (error: unknown) => error,
        ).finally(() => {
          settled = true;
        });
        if (!stream) {
          // A buffered request outlives the streaming budget.
          await time.tickAsync(PROVIDER_HEADER_TIMEOUT_MS + 1_000);
          assertEquals(
            settled,
            false,
            "the buffered request used the streaming budget",
          );
        }
        await time.tickAsync(budget + 1);
        const error = await outcome;
        assertInstanceOf(error, Error);
        assertMatch(
          error.message,
          new RegExp(
            `no response headers within ${budget}ms \\(${mode} request exceeded its budget`,
          ),
        );
        transport.assertDone();
      },
    );
  };
  deadlineTest(true);
  deadlineTest(false);
}
