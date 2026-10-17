export interface RuntimeSigintInstaller {
  add(handler: () => void): void;
}

export interface RuntimeSigintOptions {
  autostarted: boolean;
  /** The graceful shutdown; the first Ctrl-C runs it once. */
  close: () => Promise<void>;
  signals: RuntimeSigintInstaller;
  exit: (code: number) => void;
  /** Writes one line to the operator's terminal. */
  say: (line: string) => void;
  /** What the pending close is waiting on, as "waiting for <this>". */
  waitingOn: () => string;
}

/** The exit status of a runtime forced down by a third Ctrl-C: 128 + SIGINT. */
export const FORCED_EXIT_CODE = 130;

export function installRuntimeSigintHandler(
  options: RuntimeSigintOptions,
): void {
  const { close, signals, exit, say, waitingOn } = options;
  if (options.autostarted) {
    // A terminal group signal may reach the background server. Ignore it there;
    // the client translates SIGINT only during a connected UDS turn.
    signals.add(() => {});
    return;
  }
  // A foreground runtime must never become unkillable from its own terminal:
  // the first Ctrl-C starts the graceful close, a second one while it is
  // pending says what it is waiting on, and a third exits without waiting.
  let presses = 0;
  signals.add(async () => {
    presses++;
    if (presses === 2) {
      say(
        `dyfj runtime: still stopping, waiting for ${waitingOn()}; ` +
          "press Ctrl-C again to force exit",
      );
      return;
    }
    if (presses > 2) {
      say(
        "dyfj runtime: forced exit; shutdown did not finish, so warm ACP " +
          "sessions may still be running",
      );
      exit(FORCED_EXIT_CODE);
      return;
    }
    let exitCode = 0;
    try {
      await close();
    } catch {
      exitCode = 1;
    }
    exit(exitCode);
  });
}
