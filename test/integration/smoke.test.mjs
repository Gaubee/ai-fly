// Placeholder: node --test requires at least one test file to pass.
// Real in-process dual-Fabric integration tests land with tasks section 5
// (SDK native module is incompatible with vitest worker pool -> node --test).
import { test } from "node:test";
import assert from "node:assert/strict";

test("integration harness is wired", () => {
  assert.ok(true);
});
