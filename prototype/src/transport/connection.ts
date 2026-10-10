// The byte-stream ports the JSON-RPC peer, client and listener depend on.
// They name what the transport needs from a socket and nothing about which
// runtime or library supplies it; the one adapter lives in node-socket.ts.

/**
 * One end of a byte-stream connection.
 *
 * Peer half-close: when the other side sends FIN (it will write no more),
 * `read()` resolves null and this side's write side stays open until
 * `close()`, so a request that arrived just before the FIN is still answered.
 * An implementation that closes both directions on the peer's FIN loses that
 * late reply.
 */
export interface ByteConnection {
  /**
   * The next chunk, or null at end of stream. The caller owns the chunk and
   * the chunk is never empty. After `close()` this resolves null or rejects;
   * callers treat both as the end of the stream.
   */
  read(): Promise<Uint8Array | null>;
  /**
   * Resolves once every byte is accepted for sending. Partial writes and
   * backpressure belong to the implementation, never the caller. Rejects once
   * the connection is closed.
   */
  write(bytes: Uint8Array): Promise<void>;
  /** Idempotent and never throws. Ends both directions and releases the handle. */
  close(): void;
}

/** A bound socket handing out accepted connections. */
export interface ConnectionListener {
  /** The next accepted connection, or null once the listener is closed. */
  accept(): Promise<ByteConnection | null>;
  /** Idempotent and never throws. Stops accepting; open connections stay open. */
  close(): void;
}

/** The two socket ends, by Unix socket path. */
export interface SocketHost {
  /**
   * Dial `path`. An abort while dialing closes any connection that settles
   * later and rejects with the signal's reason.
   */
  connect(path: string, signal?: AbortSignal): Promise<ByteConnection>;
  /**
   * Bind `path`. The promise resolves once the socket file exists and accepts
   * connections, and a bind failure rejects it, so no caller sees a listener
   * that is not yet bound.
   */
  listen(path: string): Promise<ConnectionListener>;
}
