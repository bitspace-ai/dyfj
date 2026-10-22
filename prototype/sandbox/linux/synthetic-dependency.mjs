// A synthetic runtime dependency for the isolated machine's acceptance run
// (BIT-735, design §8). It runs inside the runtime role and uses raw socket,
// filesystem and process APIs directly, never the product's guards
// (guardedFetch, assertConnectAllowed, guardedSpawn), so only the kernel and
// the firewall can refuse it. It touches synthetic data only and prints one
// JSON line per probe: what it tried, what it expected, what happened.
//
//   node synthetic-dependency.mjs <allowed-host>
import dgram from "node:dgram";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import process from "node:process";

const allowedHost = process.argv[2];

// A refusal must be an error the kernel or firewall returned: a timeout alone
// proves nothing (design §8). A "residual" probe records what really happens
// for a gap the boundary is known not to close; it passes either way, and its
// outcome is the evidence.
function report(probe, expect, outcome) {
  const pass = expect === "residual"
    ? true
    : expect === "allowed"
    ? outcome === "ok"
    : outcome !== "ok" && outcome !== "TIMEOUT" && outcome !== "sent";
  process.stdout.write(`${JSON.stringify({ probe, expect, outcome, pass })}\n`);
}

function connect(host, port, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("TIMEOUT");
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("ok");
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve(error.code ?? error.message);
    });
  });
}

function udp(host, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
    socket.on("error", (error) => {
      socket.close();
      resolve(error.code ?? error.message);
    });
    socket.send(Buffer.from("synthetic"), port, host, (error) => {
      // A sent datagram proves nothing; the firewall counter is the evidence.
      setTimeout(() => {
        try {
          socket.close();
        } catch {}
        resolve(error ? error.code ?? error.message : "sent");
      }, 500);
    });
  });
}

function attempt(action) {
  try {
    action();
    return "ok";
  } catch (error) {
    return error.code ?? error.message;
  }
}

report("tcp to a disallowed IPv4 address", "refused", await connect("1.1.1.1", 443));
report("tcp to a disallowed IPv6 address", "refused", await connect("2606:4700:4700::1111", 443));
report("tcp to the allowed host on a disallowed port", "refused", await connect(allowedHost, 80));
report("udp to a disallowed resolver", "refused", await udp("8.8.8.8", 53));
report("tcp to the laptop's loopback service port", "refused", await connect("127.0.0.1", 8080));
report("tcp to the allowed provider", "allowed", await connect(allowedHost, 443));

report("write outside the workspace (/opt)", "refused", attempt(() => fs.writeFileSync("/opt/dyfj/synthetic-marker", "x")));
report("write outside the workspace (/)", "refused", attempt(() => fs.writeFileSync("/synthetic-marker", "x")));
report("write in the workspace", "allowed", attempt(() => fs.writeFileSync("/work/synthetic-marker", "x")));
report("read another role's home", "refused", attempt(() => fs.readdirSync("/srv/dyfj/state/cli")));
report("read the machine's root home", "refused", attempt(() => fs.readdirSync("/root")));
report(
  "execute a file from the workspace",
  "refused",
  attempt(() => {
    fs.writeFileSync("/work/synthetic-exec.sh", "#!/bin/sh\necho ran\n", { mode: 0o755 });
    execFileSync("/work/synthetic-exec.sh", { stdio: "pipe" });
  }),
);
report("execute a toolchain binary", "allowed", attempt(() => execFileSync("/usr/bin/true")));

// Landlock's execute right governs execve. The dynamic loader is itself an
// allowed toolchain file, and it maps the program it is given with mmap,
// which needs only read: so a readable copy of a binary in the workspace can
// still be run through the loader.
const LOADER = fs.readdirSync("/usr/lib").find((name) => /^ld-linux.*\.so\.\d+$/.test(name));
fs.copyFileSync("/usr/bin/true", "/work/synthetic-true");
fs.chmodSync("/work/synthetic-true", 0o755);
report(
  "execute a workspace copy of a binary directly",
  "refused",
  attempt(() => execFileSync("/work/synthetic-true")),
);
report(
  `run a workspace copy of a binary through the dynamic loader (/usr/lib/${LOADER})`,
  "residual",
  attempt(() => execFileSync(`/usr/lib/${LOADER}`, ["/work/synthetic-true"])),
);
