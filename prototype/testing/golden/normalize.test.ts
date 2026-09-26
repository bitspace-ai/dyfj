import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createNormalizer } from "./normalize.ts";

Deno.test("generated IDs get stable, first-seen placeholders", () => {
  const n = createNormalizer();
  const out = n.normalize({
    sessionId: "01M3FV3ZJWR0X2C2Q8ZYDAJQ6W",
    slug: "workbench-01m3fv3zjwr0x2c2q8zydajq6w",
    other: "01M3FV3ZZY5QZRMZVPAK1B4KZ3",
    traceId: "876b93c3a952455c8d865d6e14cd1f65",
    spanId: "de1d6d31462b4cf1",
    turnId: "8f0c2b7e-5d1a-4c3b-9e2f-1a2b3c4d5e6f",
  });
  deepStrictEqual(out, {
    sessionId: "<ULID:1>",
    slug: "workbench-<ULID:1>",
    other: "<ULID:2>",
    traceId: "<TRACE:1>",
    spanId: "<SPAN:1>",
    turnId: "<UUID:1>",
  });
});

Deno.test("timestamps keep their shape with digits masked", () => {
  const n = createNormalizer();
  strictEqual(
    n.text("sql 2026-09-26 21:49:39.370545 iso 2026-09-26T21:49:39.370Z"),
    "sql <TIMESTAMP nnnn-nn-nn nn:nn:nn.nnnnnn> " +
      "iso <TIMESTAMP nnnn-nn-nnTnn:nn:nn.nnnZ>",
  );
  strictEqual(
    n.text("Sat Sep 26 2026 21:51:50 GMT+0000 (Coordinated Universal Time)"),
    "<TIMESTAMP js-date-string>",
  );
  strictEqual(n.text("F003 · 2026-09-26 · minor"), "F003 · <DATE> · minor");
});

Deno.test("durations and PIDs are masked; other numbers are kept", () => {
  const n = createNormalizer();
  deepStrictEqual(
    n.normalize({
      duration_ms: 21,
      totalMs: 3,
      maxItems: 10,
      pid: 4242,
      tokens_input: 10,
      receipt: "Total elapsed: 47ms\nElapsed: 13 ms\nTokens: 10 in, 5 out",
      note: "runtime pid 4242",
    }),
    {
      duration_ms: "<DURATION>",
      totalMs: "<DURATION>",
      maxItems: 10,
      pid: "<PID>",
      tokens_input: 10,
      receipt:
        "Total elapsed: <DURATION>\nElapsed: <DURATION>\nTokens: 10 in, 5 out",
      note: "runtime pid <PID>",
    },
  );
});

Deno.test("registered literals are replaced, longest first", () => {
  const n = createNormalizer({
    literals: [
      ["/tmp/golden", "<TMP>"],
      ["/tmp/golden/db", "<DOLT_ROOT>"],
      ["http://127.0.0.1:41234/v1", "<MODEL_BASE_URL>"],
    ],
  });
  strictEqual(
    n.text("/tmp/golden/workspace /tmp/golden/db http://127.0.0.1:41234/v1"),
    "<TMP>/workspace <DOLT_ROOT> <MODEL_BASE_URL>",
  );
});

Deno.test("a receipt-string change is not normalized away", () => {
  const n = createNormalizer();
  const a = n.text("Paid inference used: no\nActual cost:    $0.000000");
  const b = n.text("Paid inference used: No\nActual cost:    $0.000000");
  strictEqual(a === b, false);
});
