/**
 * The runtime's shutdown composition: one place that owns the close order, the
 * SIGINT handler and the stage a repeated Ctrl-C reports.
 *
 * Split out of `main()` so the boot reads as a sequence and the close path -
 * which must run in exactly one order whichever path starts it (a client's
 * `runtime/stop`, the autostarted idle stop, or SIGINT) - is stated once.
 *
 * Order: the server closes first (it reaps warm ACP sessions and their
 * children), then the store and its pool. The store closes once, whichever
 * path runs first.
 */

import { installRuntimeSigintHandler, type RuntimeSigintInstaller } from "./sigint.ts";

/** What the composition root needs of a started server to close it. */
export interface ClosableRuntimeServer {
  close(options?: { disconnectPeers?: boolean }): Promise<void>;
}

export interface RuntimeShutdownOptions {
  autostarted: boolean;
  /** Closes the store and its pool; called once, after the server. */
  closeStore: () => Promise<void>;
  signals: RuntimeSigintInstaller;
  exit: (code: number) => void;
  say: (line: string) => void;
}

export interface RuntimeShutdown {
  /**
   * Record the started server, making it closable, and resolve the pending
   * close the SIGINT handler waits on.
   */
  attach(server: ClosableRuntimeServer): void;
  /** The graceful shutdown: server, then store. */
  shutdown(options?: { disconnectPeers?: boolean }): Promise<void>;
  /** Resolve the pending close with a start failure, so a waiting SIGINT ends. */
  fail(error: unknown): void;
  /** Install the SIGINT handler for this runtime's autostarted posture. */
  installSigint(): void;
}
export function composeRuntimeShutdown(
  options: RuntimeShutdownOptions,
): RuntimeShutdown {
  let server: ClosableRuntimeServer | undefined;
  // The shutdown, once there is a server to run it against. A SIGINT that
  // arrives while the boot is still starting waits here rather than closing
  // half a runtime.
  let resolveClose!: (close: () => Promise<void>) => void;
  const closeReady = new Promise<() => Promise<void>>((resolve) => {
    resolveClose = resolve;
  });
  // What a pending shutdown waits on, for a repeated Ctrl-C to report. Only
  // `shutdown` advances it.
  let stage = "the runtime to finish starting";

  const shutdown = async (
    closeOptions?: { disconnectPeers?: boolean },
  ): Promise<void> => {
    try {
      stage =
        "the server to close its client connections and warm ACP sessions";
      if (server !== undefined) await server.close(closeOptions);
    } catch (error) {
      // A closed-resource error from the runtime's own handles is tolerated.
      // The node:net listener swallows its own close errors, so only a runtime
      // resource elsewhere in the close path (the runners) can raise it. The
      // runner leaf of the Node runtime track removes this branch.
      if (!(error instanceof Error && error.name === "BadResource")) {
        // The server's close failure is the one to report.
        await options.closeStore().catch(() => {});
        throw error;
      }
    }
    stage = "the Dolt store's connection pool to close";
    await options.closeStore();
  };

  return {
    attach(started) {
      server = started;
      resolveClose(() => shutdown());
    },
    shutdown,
    fail(error) {
      resolveClose(() => Promise.reject(error));
    },
    installSigint() {
      installRuntimeSigintHandler({
        autostarted: options.autostarted,
        close: async () => await (await closeReady)(),
        signals: options.signals,
        exit: options.exit,
        say: options.say,
        waitingOn: () => stage,
      });
    },
  };
}
