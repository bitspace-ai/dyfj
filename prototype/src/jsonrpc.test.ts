import { describe, expect, test } from "vitest";
import {
  classify,
  dispatchRequest,
  encodeFrame,
  failure,
  FrameDecoder,
  type JsonRpcRequest,
  notification,
  RpcError,
  RpcErrorCode,
  success,
} from "./jsonrpc";

const dec = new TextDecoder();

describe("framing", () => {
  test("encodeFrame is newline-terminated JSON", () => {
    expect(dec.decode(encodeFrame(success(1, { ok: true })))).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n',
    );
  });

  test("FrameDecoder yields one message per line and buffers partials", () => {
    const d = new FrameDecoder();
    expect(d.push('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0"'))
      .toEqual([
        { ok: true, message: { jsonrpc: "2.0", id: 1, method: "a" } },
      ]);
    // the buffered partial completes on the next chunk
    expect(d.push(',"id":2,"method":"b"}\n')).toEqual([
      { ok: true, message: { jsonrpc: "2.0", id: 2, method: "b" } },
    ]);
  });

  test("FrameDecoder reports a parse error for a malformed line without throwing", () => {
    const frames = new FrameDecoder().push("not json\n");
    expect(frames.length).toBe(1);
    expect(frames[0].ok).toBe(false);
    expect(typeof frames[0].error).toBe("string");
  });
});

describe("classify", () => {
  test("distinguishes request / notification / response / invalid", () => {
    expect(classify({ jsonrpc: "2.0", id: 1, method: "turn" })).toBe("request");
    expect(classify(notification("stream", { delta: "x" }))).toBe(
      "notification",
    );
    expect(classify(success(1, {}))).toBe("response");
    expect(classify(failure("a", RpcErrorCode.paidNotApproved, "x"))).toBe(
      "response",
    );
    expect(classify({ jsonrpc: "1.0", id: 1, method: "x" })).toBe("invalid");
    expect(classify(null)).toBe("invalid");
  });
});

describe("dispatchRequest", () => {
  const req = (method: string, params?: unknown): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  test("wraps a handler result in a success envelope", async () => {
    const res = await dispatchRequest(req("models/list"), {
      "models/list": () => ({ models: [] }),
    });
    expect(res).toEqual(success(1, { models: [] }));
  });

  test("awaits async handlers", async () => {
    const res = await dispatchRequest(req("sessions/list"), {
      "sessions/list": async () => ({ sessions: ["s1"] }),
    });
    expect(res).toEqual(success(1, { sessions: ["s1"] }));
  });

  test("unknown method -> methodNotFound", async () => {
    expect(await dispatchRequest(req("nope"), {})).toEqual(
      failure(1, RpcErrorCode.methodNotFound, "method not found: nope"),
    );
  });

  test("a thrown RpcError maps to its code + data (fail-closed range)", async () => {
    const res = await dispatchRequest(req("turn"), {
      turn: () => {
        throw new RpcError(
          RpcErrorCode.paidNotApproved,
          "paid inference not approved",
          { turnId: "t1" },
        );
      },
    });
    expect(res).toEqual(
      failure(1, RpcErrorCode.paidNotApproved, "paid inference not approved", {
        turnId: "t1",
      }),
    );
  });

  test("a generic throw maps to internalError", async () => {
    const res = await dispatchRequest(req("turn"), {
      turn: () => {
        throw new Error("boom");
      },
    });
    expect(res).toEqual(failure(1, RpcErrorCode.internalError, "boom"));
  });
});

describe("error codes", () => {
  test("the DYFJ fail-closed range matches the contract", () => {
    expect(RpcErrorCode.paidNotApproved).toBe(-32010);
    expect(RpcErrorCode.budgetExceeded).toBe(-32011);
    expect(RpcErrorCode.modelUnavailable).toBe(-32012);
    expect(RpcErrorCode.remoteCannotSpend).toBe(-32013);
  });
});
