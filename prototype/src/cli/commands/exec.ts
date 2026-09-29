/** `dyfj exec` (and `ask`, `-p`): one streamed or `--json` turn. */

import { connectUnixClient } from "../../transport/mod.ts";
import { promptMidTurnApproval } from "../approval.ts";
import type { CliConfig } from "../args.ts";
import type { ConnectFn, Io, TurnInterruptSource } from "../io.ts";
import { socketError } from "../render/errors.ts";
import { formatReceipt } from "../render/receipt.ts";
import { createTurnOutputHandlers } from "../render/turn-output.ts";
import {
  createTurnSpinner,
  spinnerGuardedTurnHandlers,
} from "../render/turn-spinner.ts";
import { buildTurnBody, socketTurn, type TurnResult } from "../turn-client.ts";

export async function runExec(
  prompt: string,
  config: CliConfig,
  io: Io,
  json: boolean,
  connect: ConnectFn = connectUnixClient,
  interactive = true,
  interrupts: TurnInterruptSource | undefined = io.turnInterrupts,
): Promise<number> {
  const body = buildTurnBody(prompt, config, config.sessionId);
  const approvalController = new AbortController();
  let interruptInstalled = false;
  let interruptRequested = false;
  let stopTurnIndicator = () => {};
  const interrupt = () => {
    if (interruptRequested) return;
    interruptRequested = true;
    approvalController?.abort();
    try {
      stopTurnIndicator();
    } catch {
      // A failed terminal erase must not escape before cancellation runs.
    }
    try {
      io.err("[interrupt requested]");
    } catch {
      // A terminal write failure must not prevent the cancellation.
    }
  };
  const installInterrupt = () => {
    if (interrupts === undefined || interruptInstalled) return;
    interrupts.add(interrupt);
    interruptInstalled = true;
  };
  const onApproval = (request: unknown) =>
    promptMidTurnApproval(
      io,
      request,
      interactive,
      approvalController?.signal,
    );
  let turnFailed = false;
  let exitCode = 0;
  try {
    if (json) {
      const result = await socketTurn(
        config,
        body,
        {
          onApproval,
          abortSignal: approvalController.signal,
          onConnected: installInterrupt,
        },
        connect,
      );
      io.out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const spinner = createTurnSpinner(config, io);
      const output = createTurnOutputHandlers(config, io, {
        beforeWrite: () => spinner.pause(),
        afterWrite: () => {
          spinner.updateLabel("working…");
          spinner.start();
        },
      });
      stopTurnIndicator = () => spinner.stop();
      const handlers = spinnerGuardedTurnHandlers(
        spinner,
        output,
        io,
        onApproval,
      );
      const terminalHandlers = {
        ...handlers,
        onEvent: (event: Record<string, unknown>) => {
          if (event.type === "turnAborted") return;
          handlers.onEvent(event);
        },
      };
      spinner.start();
      let result: TurnResult;
      try {
        result = await socketTurn(
          config,
          body,
          {
            ...terminalHandlers,
            abortSignal: approvalController.signal,
            onConnected: installInterrupt,
          },
          connect,
        );
      } finally {
        // Covers every non-streaming exit — turn failure, declined approval,
        // buffered-only turns — so no orphaned spinner line survives the turn.
        spinner.stop();
      }
      // Some turns don't stream deltas (e.g. a first model call with tools);
      // the text still arrives with the receipt — render it so output is never empty.
      if (!output.streamed() && result.text.length > 0) {
        output.emitBufferedText(result.text);
      } else {
        output.finish();
      }
      if (result.stopReason === "aborted") {
        handlers.onEvent({ type: "turnAborted" });
      }
      io.err(formatReceipt(result, config.color));
    }
  } catch (error) {
    turnFailed = true;
    io.err(socketError(error, config));
    exitCode = 1;
  } finally {
    let cleanupError: unknown;
    try {
      approvalController.abort();
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (interruptInstalled) interrupts?.remove(interrupt);
    } catch (error) {
      cleanupError ??= error;
    }
    if (!turnFailed && cleanupError !== undefined) {
      io.err(socketError(cleanupError, config));
      exitCode = 1;
    }
  }
  return exitCode;
}
