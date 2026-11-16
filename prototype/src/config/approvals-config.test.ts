import assert from "node:assert/strict";
import { it } from "node:test";
import { MapEnv } from "../../testing/fakes/map-env.ts";

const eligible = [{ id: "gate/start", sessionGrantModes: ["full"] }];
it("approvals config: only declared command modes may opt in", async () => {
  const { loadApprovalsConfig } = await import("./approvals-config.ts");
  for (const entry of ["gate/start:files", "publish/start:full", "dispatch/start:full", "bash:full", "gate/start"]) {
    await assert.rejects(loadApprovalsConfig(eligible, {
      env: new MapEnv({ HOME: "/fixture" }), readTextFile: async () => "fixture",
      parseToml: () => ({ approvals: { session_grantable: [entry] } }),
    }), error => {
      assert.match(String(error), new RegExp(entry));
      assert.match(String(error), /eligible.*gate\/start:full/);
      return true;
    });
  }
});
it("approvals config: absence differs from an explicit empty opt-in list", async () => {
  const { parseApprovalsConfig } = await import("./approvals-config.ts");
  assert.equal(parseApprovalsConfig({}, eligible, "config.toml"), null);
  assert.deepEqual(parseApprovalsConfig({ approvals: {} }, eligible, "config.toml"), { sessionGrantable: [] });
  assert.deepEqual(parseApprovalsConfig({ approvals: { session_grantable: ["gate/start:full"] } }, eligible, "config.toml"), { sessionGrantable: ["gate/start:full"] });
  assert.throws(() => parseApprovalsConfig({ approvals: { session_grantable: "gate/start:full" } }, eligible, "config.toml"), /approvals.session_grantable/);
});
