import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_GRANTS_PER_SESSION, SessionGrantStore } from "./session-grants.ts";
import { SessionOwners } from "./session-owner.ts";

describe("SessionGrantStore", () => {
  it("remembers a grant for its session only", () => {
    const store = new SessionGrantStore();
    store.for("s1").add("k");
    assert.equal(store.for("s1").has("k"), true);
    assert.equal(store.for("s2").has("k"), false);
    assert.equal(store.for("s1").has("other"), false);
  });

  it("a new store, as after a runtime restart, remembers nothing", () => {
    new SessionGrantStore().for("s1").add("k");
    assert.equal(new SessionGrantStore().for("s1").has("k"), false);
  });

  it("is bounded per session, dropping the oldest grant", () => {
    const grants = new SessionGrantStore().for("s1");
    for (let i = 0; i <= MAX_GRANTS_PER_SESSION; i++) grants.add(`k${i}`);
    assert.equal(grants.has("k0"), false);
    assert.equal(grants.has(`k${MAX_GRANTS_PER_SESSION}`), true);
  });

  it("the engine's session owners hold one store across turns", () => {
    const owners = new SessionOwners();
    owners.sessionGrants("s1").add("k");
    assert.equal(owners.sessionGrants("s1").has("k"), true);
  });
});
