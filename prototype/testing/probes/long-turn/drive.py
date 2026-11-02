#!/usr/bin/env python3
"""Drive the Rust REPL through the long-turn probe against a disposable runtime.

Starts `scripts/scratch-runtime.ts up --script replies.json`, runs
`core/target/debug/dyfj-repl` under a pseudo-terminal with a cleared
environment, answers every approval with `y`, and then:

1. sends one prompt, which the scripted model answers with six replies:
   list, write, a 35 s command that exits 7, a command that times out, and a
   reply claiming everything passed;
2. sends `/evidence`;
3. sends a second prompt, which the model holds, and presses Ctrl-C after
   five seconds;
4. sends `/quit` and stops the runtime.

Everything the REPL printed is written to the transcript path given as the
first argument (default: transcript.txt beside this file), with each chunk
prefixed by the seconds since the REPL started. Exit status is 0 when the
driver reached the end, not a verdict on the transcript: read it.
"""

import fcntl
import os
import pty
import struct
import termios
import re
import select
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOTYPE = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
REPO = os.path.dirname(PROTOTYPE)
REPL = os.path.join(REPO, "core", "target", "debug", "dyfj-repl")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def start_runtime():
    up = subprocess.Popen(
        ["node", "scripts/scratch-runtime.ts", "up", "--script", os.path.join(HERE, "replies.json")],
        cwd=PROTOTYPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    state = up.stdout.readline().strip()
    if not state.endswith("state.json"):
        up.kill()
        sys.exit(f"scratch runtime did not print a state path: {state!r}")
    return up, state


def runtime_env(state):
    exports = subprocess.run(
        ["node", "scripts/scratch-runtime.ts", "env", "--state", state],
        cwd=PROTOTYPE, check=True, capture_output=True, text=True,
    ).stdout
    env = {"PATH": os.environ["PATH"], "TERM": "xterm-256color"}
    for line in exports.splitlines():
        key, _, value = line.removeprefix("export ").partition("=")
        env[key] = value.strip("'").replace("'\\''", "'")
    return env


class Session:
    def __init__(self, env, workspace, transcript):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execve(REPL, [REPL, "--model", "scratch-local", "--workspace", workspace], env)
        # 160 columns, so the status line is not cut at the default 80.
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
        self.started = time.monotonic()
        self.buffer = ""
        self.out = open(transcript, "w")

    def pump(self, seconds):
        deadline = time.monotonic() + seconds
        while (left := deadline - time.monotonic()) > 0:
            ready, _, _ = select.select([self.fd], [], [], left)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 4096).decode("utf-8", "replace")
            except OSError:
                return
            self.out.write(f"[{time.monotonic() - self.started:6.1f}] {chunk!r}\n")
            self.out.flush()
            self.buffer += ANSI.sub("", chunk)
            # Approvals are answered as they appear.
            if re.search(r"approve\? \[y/N[^\]]*\]", self.buffer):
                self.buffer = ""
                os.write(self.fd, b"y\r")

    def until(self, pattern, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if re.search(pattern, self.buffer):
                self.buffer = ""
                return True
            self.pump(0.2)
        sys.exit(f"timed out waiting for {pattern!r}; see the transcript")

    def send(self, text):
        self.out.write(f"[{time.monotonic() - self.started:6.1f}] >>> {text!r}\n")
        os.write(self.fd, text.encode())


def main():
    transcript = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "transcript.txt")
    up, state = start_runtime()
    try:
        env = runtime_env(state)
        repl = Session(env, os.path.join(os.path.dirname(state), "workspace"), transcript)
        repl.pump(4)
        repl.send("Edit notes.txt and run the checks.\r")
        repl.until(r"evidence:", 180)
        repl.pump(3)
        repl.send("/evidence\r")
        repl.pump(2)
        repl.send("Try again.\r")
        repl.pump(5)
        repl.send("\x03")
        repl.pump(5)
        repl.send("/quit\r")
        repl.pump(3)
        os.kill(repl.pid, signal.SIGTERM)
    finally:
        subprocess.run(["node", "scripts/scratch-runtime.ts", "down", "--state", state], cwd=PROTOTYPE)
        up.wait(timeout=30)
    print(transcript)


if __name__ == "__main__":
    main()
