export interface RuntimeSigintInstaller {
  add(handler: () => void): void;
}

export function installRuntimeSigintHandler(
  autostarted: boolean,
  close: () => Promise<void>,
  signals: RuntimeSigintInstaller,
  exit: (code: number) => void,
): void {
  if (autostarted) {
    // A terminal group signal may reach the background server. Ignore it there;
    // the client translates SIGINT only during a connected UDS turn.
    signals.add(() => {});
    return;
  }
  signals.add(async () => {
    let exitCode = 0;
    try {
      await close();
    } catch {
      exitCode = 1;
    }
    exit(exitCode);
  });
}
