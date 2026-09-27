/**
 * Caller-cancellation classification shared by every adapter: an error is the
 * caller's abort only when it is the caller's own signal reason.
 */

export function isAbortFromSignal(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return signal?.aborted === true && error === signal.reason;
}

export class ProviderRequestAbortedError extends Error {
  constructor(
    public readonly elapsedMs: number,
    options: { cause: unknown },
  ) {
    super("provider request aborted", options);
    this.name = "ProviderRequestAbortedError";
  }
}

export function annotateProviderAbort(
  error: unknown,
  signal: AbortSignal | undefined,
  now: () => number,
  requestStarted: number,
): never {
  if (isAbortFromSignal(error, signal)) {
    throw new ProviderRequestAbortedError(
      Math.max(0, Math.round(now() - requestStarted)),
      { cause: error },
    );
  }
  throw error;
}
