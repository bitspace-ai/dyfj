#!/usr/bin/env python3
"""Print a drive.py transcript as the terminal's scrollback would read.

Each output line is prefixed with the second it was completed. A status line
that was redrawn in place (`\\r`) shows only its last drawing before the next
line, marked `(status)`, so a wait reads as one line with its final clock.
"""

import ast
import re
import sys

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
STAMP = re.compile(r"\[\s*([\d.]+)\] (>>> )?(.*)")


def main(path):
    line, last_status, at = "", "", 0.0
    for raw in open(path):
        match = STAMP.match(raw)
        if not match:
            continue
        at = float(match.group(1))
        text = ast.literal_eval(match.group(3))
        if match.group(2):
            print(f"[{at:6.1f}] >>> {text!r}")
            continue
        for char in ANSI.sub("", text).replace("\r\n", "\n"):
            if char == "\r":
                # Overdrawn in place: remember a status drawing, drop the rest.
                if line.startswith("…"):
                    last_status = line
                line = ""
            elif char == "\n":
                if last_status:
                    print(f"[{at:6.1f}] (status) {last_status}")
                if line.strip():
                    print(f"[{at:6.1f}] {line}")
                line, last_status = "", ""
            else:
                line += char
    if line.strip():
        print(f"[{at:6.1f}] {line}")


if __name__ == "__main__":
    main(sys.argv[1])
