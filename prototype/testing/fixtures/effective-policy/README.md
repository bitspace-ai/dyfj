# Effective policy test vector

`policy.json` is a complete effective policy (version 1). `canonical.json` is
its canonical JSON, and `expected-digest.txt` is its digest. The TypeScript
digest (`prototype/src/config/effective-policy-digest.ts`) and any later Rust
helper hash `policy.json` and must produce `expected-digest.txt` byte for byte.

The digest: `sha256:<hex>` over the UTF-8 bytes of `dyfj-effective-policy/v1`,
a NUL byte, and the canonical JSON of the policy without `identity.digest`.

Canonical JSON: no whitespace; object keys sorted recursively by their UTF-8
bytes; no `undefined`; integers only (spend is integer micro-USD); every array
is a set, so its elements are canonicalized first and then sorted by the UTF-8
bytes of each element's canonical JSON. Composition order never reaches the
digest. `network.dolt` (the one database endpoint, or `null`) and
`processes.environment` (the environment names the runtime may see) are part
of the policy so that `projectRuntimePolicy` can rebuild today's
`{net, run, env, dolt}` from it.

`policy.json` carries its own digest in `identity.digest`, so
`verifyDigest(policy)` holds for it. `policy.json` uses a `null` executable
digest, syscall profile and unbounded daily spend on purpose: `null` means
"not requested" or "unbounded", and the canonical form must keep it.
Changing anything in `policy.json` changes the expected digest.
