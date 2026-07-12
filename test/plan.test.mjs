// Pure decision logic — normalization, slug keys, idempotency, view status.
// RED baseline: absent/wrong logic (a slug that is not address-safe, a second open
// that does not reuse, an invalid input that slips through).
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBranch, slugKey, planOpen, deriveViewStatus } from "../src/plan.js";

test("normalizeBranch — keeps a valid branch, sanitizes a free-form title", () => {
  assert.equal(normalizeBranch("feat/login"), "feat/login");
  assert.equal(normalizeBranch("Fix: the thing"), "Fix-the-thing");
  assert.equal(normalizeBranch("  spaced  out "), "spaced-out");
  assert.equal(normalizeBranch("issue #42 — do X"), "issue-42-do-X");
});

test("normalizeBranch — rejects the empty / unusable, obeys git ref rules", () => {
  assert.equal(normalizeBranch(""), null);
  assert.equal(normalizeBranch("   "), null);
  assert.equal(normalizeBranch("///"), null);
  assert.equal(normalizeBranch("..."), null);
  assert.equal(normalizeBranch(42), null);
  // no "..", no trailing slash/dot
  assert.ok(!String(normalizeBranch("a..b")).includes(".."));
  assert.ok(!String(normalizeBranch("trail/")).endsWith("/"));
});

test("slugKey — address-safe (^[a-z0-9][a-z0-9.-]*$), derived from the branch", () => {
  const re = /^[a-z0-9][a-z0-9.-]*$/;
  for (const b of ["feat/login", "Fix-the-thing", "issue-42-do-X", "release/1.2.0"]) {
    const k = slugKey(b);
    assert.ok(re.test(k), `${b} → ${k} must be an address-safe segment`);
  }
  assert.equal(slugKey("feat/login"), "feat-login");
  assert.equal(slugKey("release/1.2.0"), "release-1.2.0");
});

test("planOpen — first open creates, a second open of the same slug reuses (idempotent)", () => {
  const first = planOpen([], "feat/login");
  assert.equal(first.action, "create");
  assert.equal(first.branch, "feat/login");
  assert.equal(first.slug, "feat-login");

  // simulate the record the create path would persist
  const records = [{ slug: "feat-login", branch: "feat/login", windowLabel: "w-abc" }];
  const second = planOpen(records, "feat/login");
  assert.equal(second.action, "reuse");
  assert.equal(second.record.windowLabel, "w-abc");

  // a different branch that slugs the same is still reuse (same identity)
  const third = planOpen(records, "feat login");
  assert.equal(third.action, "reuse");
});

test("planOpen — an unusable input is invalid, never a create", () => {
  assert.equal(planOpen([], "").action, "invalid");
  assert.equal(planOpen([], "   ").action, "invalid");
  assert.equal(planOpen(undefined, "///").action, "invalid");
});

test("deriveViewStatus — maps each outcome to a display-only status code", () => {
  const msg = (en) => en;
  assert.deepEqual(deriveViewStatus({ kind: "loading" }, msg), { code: "loading", message: "Loading…" });
  assert.deepEqual(deriveViewStatus({ kind: "empty" }, msg), { code: "empty", message: "No workspaces" });
  assert.deepEqual(deriveViewStatus({ kind: "active", count: 3 }, msg), {
    code: "active",
    message: "3 workspace(s)",
  });
  assert.deepEqual(deriveViewStatus({ kind: "error", message: "boom" }, msg), {
    code: "error",
    message: "boom",
  });
  assert.equal(deriveViewStatus({ kind: "nonsense" }, msg), null);
});
