// Handler orchestration — the create/reuse/close/list flow, driven by scripted git-core and
// core-command responses (no live app). RED baseline: a create path that does not delegate the
// worktree to git-core, a reuse path that mints a second worktree, a close that leaves a record.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockApp } from "./helpers/mock-app.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const plugin = (await import("../main.js")).default;

// A scripted core/git-core router. Records every call; returns canned envelopes.
function router(overrides = {}) {
  const calls = [];
  const defaults = {
    "plugin.soksak-plugin-git-core.root": () => ok({ state: "repo", root: "/repo" }),
    "plugin.soksak-plugin-git-core.worktree.add": (p) =>
      ok({ dir: `/repo-wt/${p.branch.replaceAll("/", "-")}`, branch: p.branch, base: p.base ?? "HEAD" }),
    "plugin.soksak-plugin-git-core.worktree.remove": () => ok({ removed: true }),
    "plugin.soksak-plugin-git-core.worktree.list": () => ok({ worktrees: [] }),
    "window.open": () => ok({ label: "w-new" }),
    "window.close": () => ok({}),
    "window.focus": () => ok({}),
  };
  const table = { ...defaults, ...overrides };
  const fn = async (name, params) => {
    calls.push({ name, params });
    const h = table[name];
    return h ? h(params) : ok({});
  };
  return { fn, calls };
}
const ok = (data) => ({ ok: true, code: "OK", message: "", data });
const fail = (code, message) => ({ ok: false, code, message });

function boot(overrides) {
  const r = router(overrides);
  const m = mockApp({ manifest, project: { id: "p1", root: "/repo" }, executeCommand: r.fn });
  plugin.activate(m.ctx);
  const cmd = (name) => m.registered.get(name).handler;
  return { m, r, cmd };
}

test("worktree.open create — delegates worktree to git-core, opens a window, persists a record", async () => {
  const { m, r, cmd } = boot();
  const out = await cmd("worktree.open")({ name: "feat/login" });
  assert.equal(out.created, true);
  assert.equal(out.slug, "feat-login");
  assert.equal(out.branch, "feat/login");
  assert.equal(out.worktreeDir, "/repo-wt/feat-login");
  assert.equal(out.window, "w-new");
  // git-core owns the worktree creation
  assert.ok(r.calls.some((c) => c.name === "plugin.soksak-plugin-git-core.worktree.add" && c.params.branch === "feat/login"));
  assert.ok(r.calls.some((c) => c.name === "window.open" && c.params.root === "/repo-wt/feat-login"));
  // the record is persisted
  const rows = await m.app.data.query("workspace", { scope: "index" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].windowLabel, "w-new");
});

test("worktree.open reuse — a second open of the same slug focuses, never mints a second worktree", async () => {
  const { m, r, cmd } = boot({ "window.open": () => ok({ existingWindow: "w-new" }) });
  await m.app.data.put(
    "workspace",
    { slug: "feat-login", branch: "feat/login", repoRoot: "/repo", worktreeDir: "/repo-wt/feat-login", windowLabel: "w-new", createdAt: 1 },
    { scope: "index", id: "feat-login" },
  );
  const out = await cmd("worktree.open")({ name: "feat/login" });
  assert.equal(out.reused, true);
  assert.equal(out.window, "w-new");
  assert.equal(r.calls.filter((c) => c.name === "plugin.soksak-plugin-git-core.worktree.add").length, 0);
  const rows = await m.app.data.query("workspace", { scope: "index" });
  assert.equal(rows.length, 1); // still one
});

test("worktree.open — a non-repo path surfaces NOT_REPO, no worktree, no record", async () => {
  const { m, r, cmd } = boot({ "plugin.soksak-plugin-git-core.root": () => ok({ state: "not-repo" }) });
  const out = await cmd("worktree.open")({ name: "feat/x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "NOT_REPO");
  assert.equal(r.calls.filter((c) => c.name.endsWith("worktree.add")).length, 0);
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 0);
});

test("worktree.open — an unusable name is INVALID_NAME, never a create", async () => {
  const { cmd } = boot();
  const out = await cmd("worktree.open")({ name: "   " });
  assert.equal(out.ok, false);
  assert.equal(out.code, "INVALID_NAME");
});

test("worktree.close — closes the window, removes the worktree, deletes the record", async () => {
  const { m, r, cmd } = boot();
  await m.app.data.put(
    "workspace",
    { slug: "feat-login", branch: "feat/login", repoRoot: "/repo", worktreeDir: "/repo-wt/feat-login", windowLabel: "w-new", createdAt: 1 },
    { scope: "index", id: "feat-login" },
  );
  const out = await cmd("worktree.close")({ name: "feat/login" });
  assert.equal(out.closed, true);
  assert.ok(r.calls.some((c) => c.name === "window.close" && c.params.label === "w-new"));
  assert.ok(r.calls.some((c) => c.name === "plugin.soksak-plugin-git-core.worktree.remove" && c.params.dir === "/repo-wt/feat-login"));
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 0);
});

test("worktree.close — an absent workspace is an idempotent no-op", async () => {
  const { cmd } = boot();
  const out = await cmd("worktree.close")({ name: "nope" });
  assert.equal(out.closed, false);
  assert.equal(out.slug, "nope");
});

test("worktree.close — refuses (keeps record) when git-core reports the worktree still present", async () => {
  const { m, r, cmd } = boot({
    "plugin.soksak-plugin-git-core.worktree.remove": () => fail("GIT_ERROR", "contains modified or untracked files"),
    "plugin.soksak-plugin-git-core.worktree.list": () => ok({ worktrees: [{ path: "/repo-wt/feat-login" }] }),
  });
  await m.app.data.put(
    "workspace",
    { slug: "feat-login", branch: "feat/login", repoRoot: "/repo", worktreeDir: "/repo-wt/feat-login", windowLabel: "w-new", createdAt: 1 },
    { scope: "index", id: "feat-login" },
  );
  const out = await cmd("worktree.close")({ name: "feat/login" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "GIT_ERROR");
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 1); // record kept
});

test("worktree.list — returns the persisted records", async () => {
  const { m, cmd } = boot();
  for (const s of ["a", "b"]) {
    await m.app.data.put(
      "workspace",
      { slug: s, branch: s, repoRoot: "/repo", worktreeDir: `/repo-wt/${s}`, windowLabel: `w-${s}`, createdAt: s === "a" ? 1 : 2 },
      { scope: "index", id: s },
    );
  }
  const out = await cmd("worktree.list")({});
  assert.equal(out.workspaces.length, 2);
  assert.deepEqual(out.workspaces.map((w) => w.slug), ["a", "b"]);
});
