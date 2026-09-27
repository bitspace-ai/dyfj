// Conformance suite for the `Env` port (`src/config/env.ts`).
//
// The `MapEnv` fake runs it in the unit lane; the real `processEnv` adapter runs
// it in the integration lane, where the process is granted the probe key. Both
// must agree with `Deno.env`: unset reads `undefined`, empty reads `""`, and a
// write is visible to the next read.

import { assertStrictEquals } from "@std/assert";
import type { MutableEnv } from "../../src/config/env.ts";

export interface EnvConformanceSubject {
  name: string;
  /** A fresh env in which `probeKey` is unset. */
  make(): MutableEnv;
  /** A key the subject may read and write; restored by `cleanup`. */
  probeKey: string;
  cleanup?(): void;
}

export function envConformance(subject: EnvConformanceSubject): void {
  const run = (label: string, body: (env: MutableEnv) => void) => {
    Deno.test(`Env conformance (${subject.name}): ${label}`, () => {
      const env = subject.make();
      try {
        body(env);
      } finally {
        subject.cleanup?.();
      }
    });
  };
  const key = subject.probeKey;

  run("an unset key reads undefined", (env) => {
    assertStrictEquals(env.get(key), undefined);
  });

  run("a set value is read back", (env) => {
    env.set(key, "value");
    assertStrictEquals(env.get(key), "value");
  });

  run("an empty value is defined and distinct from unset", (env) => {
    env.set(key, "");
    assertStrictEquals(env.get(key), "");
  });

  run("a later set overwrites an earlier one", (env) => {
    env.set(key, "first");
    env.set(key, "second");
    assertStrictEquals(env.get(key), "second");
  });
}
