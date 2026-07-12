// Handler orchestration — the create/reuse/close/list flow.
//
// git is not run here and is not mocked at the process level: this plugin consumes
// soksak-git-spec@1 and calls whoever implements it. So the harness plays the implementer, and the
// id it plays is deliberately not the one that ships — an implementer named anywhere in this plugin
// would fail these tests.
//
// RED baseline: a create that never asks the provider for a worktree, a reuse that mints a second
// one, an attach that re-creates the branch, a close that leaves a record behind.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockApp } from "./helpers/mock-app.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const plugin = (await import("../main.js")).default;

const CONTRACT = "soksak-git-spec@1";
const PROVIDER = "soksak-plugin-any-git";
const ok = (data) => ({ ok: true, code: "OK", message: "", data });
const fail = (code, message) => ({ ok: false, code, message });

// The implementer's answers, by contract command name.
function defaultGit() {
  return {
    root: () => ok({ state: "repo", root: "/repo" }),
    "branch.exists": () => ok({ exists: false }), // absent by default → a new branch
    "worktree.add": (p) =>
      ok({ dir: p.dir, branch: p.branch, base: p.attach ? null : p.base, attached: p.attach === true }),
    "worktree.remove": (p) => ok({ removed: p.dir }),
    "worktree.list": () => ok({ worktrees: [] }),
  };
}

// One router for both surfaces the plugin talks to: the core's commands, and the contract's
// implementer (discovered through plugin.implementers, never named).
function router({ core = {}, git = {}, implementers } = {}) {
  const calls = [];
  const gitCalls = [];
  const coreTable = {
    "program.list": () => ok({ programs: [{ id: "terminal-xterm" }, { id: "terminal-ghostty" }] }),
    "project.open": () => ok({ projectId: "t2", spaceId: "c2", panelId: "g2", viewId: "v2" }),
    "state.tree": () => ok({ projects: [{ id: "t2", root: "/repo-wt/feat-login" }] }),
    "project.close": () => ok({}),
    "project.activate": () => ok({}),
    "window.focus": () => ok({}),
    ...core,
  };
  const gitTable = { ...defaultGit(), ...git };
  const enabled = implementers ?? [{ id: PROVIDER, version: "1.0.0", status: "enabled" }];

  const fn = async (name, params) => {
    calls.push({ name, params });
    if (name === "plugin.implementers") return ok({ contract: params?.contract, implementers: enabled });
    if (name.startsWith(`plugin.${PROVIDER}.`)) {
      const cmd = name.slice(`plugin.${PROVIDER}.`.length);
      gitCalls.push({ cmd, params });
      const h = gitTable[cmd];
      return h ? h(params) : ok({});
    }
    const h = coreTable[name];
    return h ? h(params) : ok({});
  };
  return { fn, calls, gitCalls };
}

function boot(opts = {}) {
  const r = router(opts);
  const m = mockApp({ manifest, project: { id: "p1", root: "/repo" }, executeCommand: r.fn });
  plugin.activate(m.ctx);
  const cmd = (name) => m.registered.get(name).handler;
  return { m, r, cmd };
}
const seed = (m, rec) => m.app.data.put("workspace", rec, { scope: "index", id: rec.slug });

// The invariant every test below rides on: the implementer is discovered, never named.
const namesNoImplementer = (r) => {
  for (const c of r.calls) {
    assert.ok(!c.name.includes("git-core"), `an implementer is named: ${c.name}`);
  }
  assert.ok(
    r.calls.some((c) => c.name === "plugin.implementers" && c.params?.contract === CONTRACT),
    "the provider was never resolved by contract",
  );
};

test("worktree.open create — asks the provider for a worktree, opens a project+terminal, persists a record", async () => {
  const { m, r, cmd } = boot();
  const out = await cmd("worktree.open")({ name: "feat/login" });
  assert.equal(out.created, true);
  assert.equal(out.slug, "feat-login");
  assert.equal(out.branch, "feat/login");
  assert.equal(out.worktreeDir, "/repo-wt/feat-login");
  assert.equal(out.project, "t2");
  assert.equal(out.attached, false);

  const add = r.gitCalls.find((c) => c.cmd === "worktree.add");
  assert.ok(add, "the provider was never asked for a worktree");
  assert.equal(add.params.branch, "feat/login");
  assert.equal(add.params.dir, "/repo-wt/feat-login");
  assert.equal(add.params.attach, false, "a fresh branch is created, not attached");
  namesNoImplementer(r);

  const po = r.calls.find((c) => c.name === "project.open");
  assert.equal(po.params.root, "/repo-wt/feat-login");
  assert.equal(po.params.program, "terminal-xterm");
  const rows = await m.app.data.query("workspace", { scope: "index" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, "t2");
});

test("worktree.open reuse — a second open of the same slug activates, never asks for a second worktree", async () => {
  const { m, r, cmd } = boot();
  await seed(m, { slug: "feat-login", branch: "feat/login", repoRoot: "/repo", worktreeDir: "/repo-wt/feat-login", projectId: "t2", windowLabel: "w-a", createdAt: 1 });
  const out = await cmd("worktree.open")({ name: "feat/login" });
  assert.equal(out.reused, true);
  assert.equal(r.gitCalls.filter((c) => c.cmd === "worktree.add").length, 0);
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 1);
});

test("worktree.open attach — a surviving branch (no record) attaches a worktree, never re-creates it", async () => {
  // The close⇄open pair: close kept the branch, removed the worktree and the record. Opening the
  // same name must attach to the branch that carries the work, not try to create it again.
  const { m, r, cmd } = boot({ git: { "branch.exists": () => ok({ exists: true }) } });
  const out = await cmd("worktree.open")({ name: "feat/login" });
  assert.equal(out.created, true);
  assert.equal(out.attached, true);
  const add = r.gitCalls.find((c) => c.cmd === "worktree.add");
  assert.equal(add.params.attach, true, "an existing branch must be attached, never re-created");
  assert.equal(add.params.branch, "feat/login");
  assert.equal(add.params.dir, "/repo-wt/feat-login");
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 1);
});

test("worktree.open — a non-repo path surfaces NOT_REPO, no worktree, no record", async () => {
  const { m, r, cmd } = boot({ git: { root: () => ok({ state: "not-repo" }) } });
  const out = await cmd("worktree.open")({ name: "feat/x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "NOT_REPO");
  assert.equal(r.gitCalls.filter((c) => c.cmd === "worktree.add").length, 0);
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 0);
});

test("worktree.open — a repository git cannot read is an error, never a create", async () => {
  // The tri-state matters here: answering "not-repo" for a broken repository would let this plugin
  // carry on and put a worktree in a directory git already refused to read.
  const { m, r, cmd } = boot({ git: { root: () => fail("GIT_ERROR", "invalid gitfile format") } });
  const out = await cmd("worktree.open")({ name: "feat/x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "GIT_ERROR");
  assert.equal(r.gitCalls.filter((c) => c.cmd === "worktree.add").length, 0);
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 0);
});

test("worktree.open — no enabled implementer is a loud refusal, never a silent skip", async () => {
  const { m, r, cmd } = boot({ implementers: [] });
  const out = await cmd("worktree.open")({ name: "feat/x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "NO_GIT_PROVIDER");
  assert.equal(r.gitCalls.length, 0);
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 0);
});

test("worktree.open — an unusable name is INVALID_NAME, never a create", async () => {
  const { cmd } = boot();
  const out = await cmd("worktree.open")({ name: "   " });
  assert.equal(out.ok, false);
  assert.equal(out.code, "INVALID_NAME");
});

test("worktree.close — closes the project, removes the worktree, deletes the record", async () => {
  const { m, r, cmd } = boot();
  await seed(m, { slug: "feat-login", branch: "feat/login", repoRoot: "/repo", worktreeDir: "/repo-wt/feat-login", projectId: "t2", windowLabel: "w-a", createdAt: 1 });
  const out = await cmd("worktree.close")({ name: "feat/login" });
  assert.equal(out.closed, true);
  assert.ok(r.calls.some((c) => c.name === "project.close" && c.params.project === "t2"));
  const rm = r.gitCalls.find((c) => c.cmd === "worktree.remove");
  assert.ok(rm && rm.params.dir === "/repo-wt/feat-login", "the provider was never asked to remove the worktree");
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 0);
});

test("worktree.close — an absent workspace is an idempotent no-op", async () => {
  const { cmd } = boot();
  const out = await cmd("worktree.close")({ name: "nope" });
  assert.equal(out.closed, false);
  assert.equal(out.slug, "nope");
});

test("worktree.close — refuses (keeps record) when the worktree is still there", async () => {
  // The provider refuses a worktree with uncommitted changes. That refusal is the feature: the
  // record survives, so the workspace is still reachable and the work is not orphaned.
  const { m, cmd } = boot({
    git: {
      "worktree.remove": () => fail("GIT_ERROR", "contains modified or untracked files"),
      "worktree.list": () => ok({ worktrees: [{ path: "/repo-wt/feat-login", head: "a" }] }),
    },
  });
  await seed(m, { slug: "feat-login", branch: "feat/login", repoRoot: "/repo", worktreeDir: "/repo-wt/feat-login", projectId: "t2", windowLabel: "w-a", createdAt: 1 });
  const out = await cmd("worktree.close")({ name: "feat/login" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "GIT_ERROR");
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 1);
});

test("worktree.list — returns the persisted records", async () => {
  const { m, cmd } = boot();
  for (const s of ["a", "b"]) {
    await seed(m, { slug: s, branch: s, repoRoot: "/repo", worktreeDir: `/repo-wt/${s}`, projectId: `t-${s}`, windowLabel: `w-${s}`, createdAt: s === "a" ? 1 : 2 });
  }
  const out = await cmd("worktree.list")({});
  assert.equal(out.workspaces.length, 2);
  assert.deepEqual(out.workspaces.map((w) => w.slug), ["a", "b"]);
});
