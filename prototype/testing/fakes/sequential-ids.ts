// Test fake for the `IdSource` port: deterministic IDs in issue order.
//
// The real adapter issues ULIDs. These IDs keep the ULID shape — 26
// characters from the Crockford base-32 alphabet — so code that validates or
// sorts ULIDs accepts them, and they sort lexically in the order issued.

const ULID_LENGTH = 26;

export interface SequentialIdsOptions {
  /** The first counter value issued. Default 1. */
  start?: number;
}

export class SequentialIds {
  #nextValue: number;
  readonly #issued: string[] = [];

  constructor(options: SequentialIdsOptions = {}) {
    const start = options.start ?? 1;
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new RangeError("SequentialIds start must be a safe integer >= 0");
    }
    this.#nextValue = start;
  }

  /** The next ID. Bound, so it can be passed as a `() => string`. */
  readonly next = (): string => {
    const id = String(this.#nextValue).padStart(ULID_LENGTH, "0");
    this.#nextValue += 1;
    this.#issued.push(id);
    return id;
  };

  /** Every ID issued so far, in order. */
  get issued(): readonly string[] {
    return [...this.#issued];
  }
}
