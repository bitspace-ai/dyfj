import { codexChatGptProfile } from "../src/external-agent-runtime";

const profile = await codexChatGptProfile(Deno.cwd());
const environment = { ...profile.environment };
delete environment.NO_BROWSER;

const child = new Deno.Command(profile.command, {
  args: [...profile.args, "login"],
  cwd: profile.workspace,
  clearEnv: true,
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

Deno.exit((await child.status).code);
