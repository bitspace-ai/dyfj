# Recipe: add a model provider

Status: normative for adding providers. It implements `01-architecture.md`
section 5.2 and PRD-12 R1. The living example is the test-only synthetic adapter
in `prototype/testing/providers/synthetic/`, which was written by following this
recipe and passes the kit.

Paths below are relative to `prototype/`.

## First: do you need an adapter at all?

A new provider that speaks an API family DYFJ already has needs **no code in
`engine/` and usually no adapter code**:

- **Catalog.** Add its models in a catalog/pricing migration under `schema/`
  (`provider`, `api`, `base_url`, `tier`, `cost_input`, `cost_output`, limits).
  A paid model without prices is not routable.
- **Host pin (hosted providers only).** A hosted OpenAI-compatible provider also
  needs one entry in `openAIHostedProviderContracts`
  (`src/providers/openai-compatible/providers.ts`): the environment variable
  that holds its key and the one https host that key may be sent to. That map is
  what admits a provider to the hosted wire path, so a catalog row alone cannot
  send a credential anywhere new. If the provider's modality should read as
  frontier or aggregator rather than custom, add its canonical host to
  `getModelAccessModality` (`src/providers/registry/catalog.ts`).
- **Local servers.** A new loopback server speaking the OpenAI-compatible wire
  format is one entry in `openAICompatibleLocalProviders` in the same file.

Stop here unless the provider speaks a wire format no adapter implements.

## Adding an API family

Cost: one adapter directory, one registry line, passing the provider conformance
kit. Nothing in `engine/`, `store/`, `config/` or other adapters changes.

### 1. The adapter directory

Create `src/providers/<family>/` with:

| File             | Holds                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `request.ts`     | The wire request body, built from the turn. Offer tools under `toolWireNames` so dotted command ids stay wire-safe.        |
| `stream.ts`      | Response reading: the buffered reader, the streaming reader, and the line parser. Read SSE with `shared/sse.ts`.           |
| `usage.ts`       | Input, output and reasoning tokens and cost from what the provider reported, falling back to `shared/tokens.ts` estimates. |
| `stop-reason.ts` | The provider's stop value mapped to `stop`, `length`, `tool_use` or `error`.                                               |
| `adapter.ts`     | The exported `ProviderAdapter`.                                                                                            |

The `ProviderAdapter` (`src/providers/adapter.ts`):

- `api`: the family name; `providers`: the catalog `provider` values it serves.
  The registry dispatches on `provider`, and two adapters may not serve the same
  one.
- `streamsToolCalls`, `supportsTranscriptRetry`, `defaultOutputTokens(model)`:
  what the engine may ask of this family (buffer tool-offering calls or stream
  them; retry with a rewritten transcript; the output ceiling when the caller
  sets none).
- `validateBaseUrl(model)`: loopback-only for a local family, https for a hosted
  one, and a hosted family that sends a credential pins the host
  (`shared/base-url.ts`). It runs before any request.
- `run(request, io)`: everything else, through `io` only. `io.fetch` is the
  `HttpTransport` port, `io.clock` the clock, `io.env` the environment (read the
  credential here, and fail with `HostedProviderCredentialMissingError` when it
  is absent), `io.signal` the caller's cancellation, and `io.onFrame` the live
  text sink; a turn streams exactly when `onFrame` is present.

Reuse the shared pieces rather than re-implementing them:

- `http.ts`: `fetchWithHeaderTimeout` with `providerFetchDeadline(stream)`, so
  the request carries the streaming or buffered header budget, and
  `shared/abort.ts` `annotateProviderAbort` on its rejection.
- `shared/turn-result.ts`: return
  `abortedWorkbenchTurnResult(request, 0,
  false)` when the signal is already
  aborted before dispatch.
- `shared/stop-reason.ts`: `stopReasonWithAbort`, so a provider-reported error
  outranks a concurrent cancellation.
- `shared/tokens.ts`: `withTimePerOutputToken` for timings, and the estimates.
- Map tool-call names back to registry names before returning them.

Rules that hold for every adapter:

- Refuse redirects (`redirect: "error"`) unless the family has a reason to
  follow them.
- Messages of `DomainError`s cross the wire as trusted text. Put
  registry-sourced values into one only through the bounded fields in
  `errors.ts`.
- Bound what you read from the provider; follow the OpenAI-compatible adapter's
  response ceilings.

### 2. One registry line

Add the adapter to `PROVIDER_ADAPTERS` in `src/providers/registry/registry.ts`.

### 3. The conformance kit

Add `src/providers/<family>/conformance.test.ts` calling
`providerAdapterConformance` from `testing/conformance/provider-adapter.ts` with
recorded fixtures for every case: plain text, native tool calls, text-markup
tool calls, usage and cost, a length stop, a mid-stream error, an abort, and a
base-URL rejection. Each fixture holds the requests the adapter must send
(assertions on the recorded request) and the provider's recorded responses,
replayed by the scripted `HttpTransport`. Record the responses from the real
provider's documented wire format; never point a test at the real service.

A case the family does not support still gets a fixture that pins what the
adapter does instead (for example `toolCalls: undefined` for a family that never
returns tool calls).

The kit derives the header-deadline and pre-dispatch-abort cases itself. An
adapter is mergeable only when the kit passes.

### 4. Unit tests and docs

- Edge cases beyond the kit (limits, usage accounting across frames, request
  shapes) go in unit tests next to the module they cover, using the scripted
  transport and the `MapEnv` and `ManualClock` fakes.
- Add a `CHANGELOG.md` entry and update the provider list wherever the README
  describes hosted providers.
