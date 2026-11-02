# Long-turn probe

A scripted turn that checks whether a long Workbench turn is legible and its
record honest when watched from the Rust REPL. It is a manual probe, not a
gate lane: it takes about a minute and needs a pseudo-terminal.

`replies.json` is the loopback model's script: list files, write
`notes.txt`, run a command that sleeps 35 s and exits 7, run a command with a
3 s timeout that sleeps 10 s, then reply "All checks passed. Everything is
verified." The last entry holds the next request open.

`drive.py` starts `scripts/scratch-runtime.ts up --script replies.json`,
runs `core/target/debug/dyfj-repl` under a pty with a cleared environment
plus the runtime's exports, answers each approval with `y`, sends the
prompt, `/evidence`, a second prompt, Ctrl-C five seconds later, and
`/quit`, then runs `scratch-runtime.ts down`. It writes the raw transcript
with a timestamp per chunk.

`render.py` prints the transcript as scrollback. A status line redrawn in
place shows as one `(status)` line with its last clock.

Build the REPL first (`cargo build -p dyfj-repl` in `core/`). From
`prototype/`:

```bash
python3 testing/probes/long-turn/drive.py /tmp/long-turn.txt
```

```bash
python3 testing/probes/long-turn/render.py /tmp/long-turn.txt
```

Look for:

- `! bash sleep 35; … · exit 7` and `! bash sleep 10; npm test … · timed out
  after 3000ms …` as the calls complete;
- a `(status) … running bash sleep 35; … 34s` line before the exit 7 line:
  the wait had a named subject and a clock;
- `· evidence: 4 calls in 4 steps: 2 ok, 2 commands failed (exit 7; timed
  out after 3000ms)`, `no command exited 0 after these writes: notes.txt`,
  and `it does not check the reply's claims`; nothing in the record says a
  check passed or the work was verified;
- `/evidence` listing all four calls with start and end seconds;
- after the second prompt and Ctrl-C, `cancelling…` and the turn settling
  with its receipt, back at the prompt.

The driver exits 0 when it reached the end. That is not a verdict: read the
rendered transcript.
