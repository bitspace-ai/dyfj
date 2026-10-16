// Signs the isolated Codex ChatGPT runner home in to ChatGPT: runs the pinned
// Codex adapter's `login` with the runner's environment and nothing else.
// The adapter runs on `DYFJ_NODE_PATH` when it is set, and otherwise on the
// Node executable running this script.
import { spawn } from "node:child_process";
import process from "node:process";
import { codexChatGptProfile } from "../src/external-agent-runtime.ts";

if (process.argv.includes("--help")) {
  console.log(
    "usage: npm run codex-chatgpt-login\n\nSigns the isolated Codex ChatGPT runner home (~/.dyfj/runner-homes/codex-chatgpt)\nin to ChatGPT through the pinned Codex adapter. The adapter runs on\nDYFJ_NODE_PATH when it is set, and otherwise on the Node running this script.",
  );
  process.exit(0);
}

const profile = await codexChatGptProfile(process.cwd(), {
  nodePath: process.env.DYFJ_NODE_PATH || process.execPath,
  toolchainPath: "",
  rustupHome: "",
});
const environment = { ...profile.environment };
delete environment.NO_BROWSER;

const child = spawn(profile.command, [...profile.args, "login"], {
  cwd: profile.workspace,
  env: environment,
  stdio: "inherit",
});
const code = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (exitCode) => resolve(exitCode ?? 1));
});
process.exit(code);
