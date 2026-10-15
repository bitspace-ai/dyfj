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
// tool calls, usage and cost, a length stop, a mid-stream error, an abort, a
// base-URL rejection, an off-host https base-URL rejection, and a redirect
// response. An adapter that does not support a case still supplies the
// fixture and pins what it does instead: an adapter that never returns tool
// calls pins `toolCalls: undefined`. The kit derives two more cases from the
// plain-text fixture: the header deadline in both request modes, and an abort
// observed before dispatch.
//
// An adapter may add named `cases`: further recorded fixtures for the request
// building and stream parsing the required cases do not pin (a request field,
// a cache or reasoning usage figure, a frame the parser must skip). Each runs
// through the same harness and invariants as a required case.
//
// Invariants the kit adds to every fixture: every scripted exchange is used;
// every request refuses redirects (`redirect: "error"`); a streamed turn's
// frames concatenate to its result text, so live output and the durable text
// agree; and each case's defining property (for example a base-URL rejection
// sends no request, and an off-host base URL is https on a host other than the
// plain-text model's).

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setImmediate } from "node:timers";
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
  /**
   * An https base URL on a host other than the plain-text model's: it must be
   * rejected before any request.
   */
  offHostBaseUrl: KitFixture;
  /** One exchange answered with a redirect status: the turn must fail. */
  redirect: KitFixture;
}

export interface ProviderKitSubject {
  name: string;
  adapter: ProviderAdapter;
  fixtures: ProviderKitFixtures;
  /** Further recorded cases, keyed by test name. */
  cases?: Record<string, KitFixture>;
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
      assert.strictEqual(
        (result as unknown as Record<string, unknown>)[key],
        undefined,
        `result.${key} should be undefined`,
      );
    } else {
      defined[key] = value;
    }
  }
  assert.partialDeepStrictEqual(
    result as unknown as Record<string, unknown>,
    defined,
  );
}

function assertExpectation(run: KitRun, fixture: KitFixture): void {
  const expected = fixture.expect;
  if ("error" in expected) {
    assert.ok(
      run.error !== undefined,
      `expected the turn to fail, but it resolved: ${
        JSON.stringify(run.result)
      }`,
    );
    if (expected.error.instance) {
      assert.ok(run.error instanceof expected.error.instance);
    }
    if (expected.error.message !== undefined) {
      const message = (run.error as Error).message;
      if (typeof expected.error.message === "string") {
        assert.ok(
          message.includes(expected.error.message),
          `expected ${
            JSON.stringify(message)
          } to include expected.error.message`,
        );
      } else {
        assert.match(message, expected.error.message);
      }
    }
    return;
  }
  if (run.error !== undefined) throw run.error;
  const result = run.result!;
  assertResultMatches(result, expected.result);
  if (expected.frames !== undefined) {
    assert.deepStrictEqual(run.frames, expected.frames);
  }
  if (fixture.stream) {
    assert.deepStrictEqual(
      run.frames.join(""),
      result.text,
      "live frames and the durable text diverged",
    );
  } else {
    assert.deepStrictEqual(run.frames, [], "a buffered turn emitted frames");
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
    test(label(name), async () => {
      const run = await runKitFixture(adapter, fixture);
      assertExpectation(run, fixture);
      for (const request of run.transport.requests) {
        assert.deepStrictEqual(
          request.redirect,
          "error",
          `the request to ${request.url} must refuse redirects`,
        );
      }
      extra(run);
      run.transport.assertDone();
    });
  };

  caseTest("plain text", fixtures.plainText, (run) => {
    assert.ok(fixtures.plainText.stream, "the plain-text fixture must stream");
    const result = resultOf(run);
    assert.deepStrictEqual(result.stopReason, "stop");
    assert.strictEqual(result.toolCalls, undefined);
    assert.ok(run.frames.length > 0, "a streamed plain-text turn emits frames");
  });

  caseTest("native tool calls", fixtures.nativeToolCalls, (run) => {
    const expected = fixtures.nativeToolCalls.expect;
    assert.ok(
      "result" in expected && "toolCalls" in expected.result,
      "the native tool-call fixture must pin toolCalls",
    );
    resultOf(run);
  });

  caseTest("text-markup tool calls", fixtures.textMarkupToolCalls, (run) => {
    const expected = fixtures.textMarkupToolCalls.expect;
    assert.ok(
      "result" in expected && "toolCalls" in expected.result,
      "the text-markup fixture must pin toolCalls",
    );
    assert.ok(
      (fixtures.textMarkupToolCalls.turn?.tools?.length ?? 0) > 0,
      "the text-markup fixture must offer tools",
    );
    resultOf(run);
  });

  caseTest("usage and cost", fixtures.usage, (run) => {
    const expected = fixtures.usage.expect;
    assert.ok(
      "result" in expected && "usage" in expected.result,
      "the usage fixture must pin usage",
    );
    // Usage is pinned exactly, not as a subset.
    assert.deepStrictEqual(resultOf(run).usage, expected.result.usage);
  });

  caseTest("length stop", fixtures.lengthStop, (run) => {
    assert.deepStrictEqual(resultOf(run).stopReason, "length");
  });

  caseTest("mid-stream error", fixtures.midStreamError, (run) => {
    assert.ok(
      fixtures.midStreamError.stream,
      "the error must arrive mid-stream",
    );
    assert.ok("error" in fixtures.midStreamError.expect);
    assert.ok(run.error !== undefined);
  });

  caseTest("abort", fixtures.abort, (run) => {
    assert.ok(
      fixtures.abort.abortAfterFrames !== undefined,
      "the abort fixture must abort after a frame",
    );
    const result = resultOf(run);
    assert.deepStrictEqual(result.stopReason, "aborted");
    assert.strictEqual(result.toolCalls, undefined);
  });

  caseTest("base-URL rejection", fixtures.baseUrlRejection, (run) => {
    assert.ok(
      !adapter.validateBaseUrl(fixtures.baseUrlRejection.model).ok,
      "validateBaseUrl must reject the fixture's model",
    );
    assert.ok("error" in fixtures.baseUrlRejection.expect);
    assert.deepStrictEqual(
      run.transport.requests.length,
      0,
      "a request was sent",
    );
  });

  caseTest("off-host base-URL rejection", fixtures.offHostBaseUrl, (run) => {
    const offHost = new URL(fixtures.offHostBaseUrl.model.baseUrl);
    assert.deepStrictEqual(
      offHost.protocol,
      "https:",
      "the off-host URL must be https",
    );
    assert.ok(
      offHost.hostname !== new URL(fixtures.plainText.model.baseUrl).hostname,
      "the off-host URL must name a host other than the plain-text model's",
    );
    assert.ok(
      adapter.providers.has(fixtures.offHostBaseUrl.model.provider),
      "the off-host fixture's provider must be one the adapter serves",
    );
    assert.ok(
      !adapter.validateBaseUrl(fixtures.offHostBaseUrl.model).ok,
      "validateBaseUrl must reject an off-host https base URL",
    );
    assert.ok("error" in fixtures.offHostBaseUrl.expect);
    assert.deepStrictEqual(
      run.transport.requests.length,
      0,
      "a request was sent",
    );
  });

  caseTest("redirect response", fixtures.redirect, (run) => {
    const exchanges = fixtures.redirect.exchanges;
    assert.deepStrictEqual(
      exchanges.length,
      1,
      "the redirect fixture has one exchange",
    );
    const respond = exchanges[0].respond;
    assert.ok(
      typeof respond !== "function" &&
        REDIRECT_STATUSES.has(respond.status ?? 200),
      "the redirect fixture must answer with a redirect status",
    );
    assert.ok("error" in fixtures.redirect.expect);
    assert.deepStrictEqual(
      run.transport.requests.length,
      1,
      "the redirect fixture must send exactly one request",
    );
  });

  for (const [name, fixture] of Object.entries(subject.cases ?? {})) {
    caseTest(name, fixture);
  }

  test(label("the plain-text model passes validateBaseUrl"), () => {
    assert.ok(adapter.validateBaseUrl(fixtures.plainText.model).ok);
    assert.ok(adapter.providers.has(fixtures.plainText.model.provider));
  });

  test(label("an abort before dispatch sends nothing"), async () => {
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
    assert.deepStrictEqual(result.usage.input, 0);
    assert.deepStrictEqual(transport.requests.length, 0);
  });

  // Advances the faked clock by `ms`, letting pending promise work settle on
  // a real macrotask turn before and after, so a timer armed after an await
  // is in place when the clock moves and its effects have run when it stops.
  const tickAsync = async (ms: number) => {
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };

  const deadlineTest = (stream: boolean) => {
    const budget = stream
      ? PROVIDER_HEADER_TIMEOUT_MS
      : PROVIDER_BUFFERED_HEADER_TIMEOUT_MS;
    const mode = stream ? "streaming" : "buffered";
    test(
      label(`a ${mode} request fails at its header deadline`),
      async () => {
        // The header deadline is a `setTimeout`; only that is faked.
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
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
            await tickAsync(PROVIDER_HEADER_TIMEOUT_MS + 1_000);
            assert.deepStrictEqual(
              settled,
              false,
              "the buffered request used the streaming budget",
            );
          }
          await tickAsync(budget + 1);
          const error = await outcome;
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            new RegExp(
              `no response headers within ${budget}ms \\(${mode} request exceeded its budget`,
            ),
          );
          transport.assertDone();
        } finally {
          mock.timers.reset();
        }
      },
    );
  };
  deadlineTest(true);
  deadlineTest(false);
}
