# Code fingerprint test vector

`tree/` and `expected-hash.txt` pin the source-tree content hash that the
runtime, the TypeScript client and the Rust REPL each compute
(`prototype/src/config/code-fingerprint.ts`, `core/dyfj-repl/src/posture.rs`).
All three tests hash `tree/` and compare against `expected-hash.txt`, so the
three implementations cannot drift apart.

The hash: every regular file under the root, skipping any entry whose name
starts with `.` and every symlink; sorted by relative path (`/`-separated,
compared as UTF-8 bytes); SHA-256 over, for each file, its path, a NUL byte,
its length in decimal, a NUL byte, and its content. Written as
`sha256:<hex>`.

`tree/.hidden` and `tree/.skipped-dir/` are skipped; `B.txt` sorts before
`a.txt` by byte order. Changing anything under `tree/` changes the expected
hash.
