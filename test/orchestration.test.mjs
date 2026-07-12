// Handler orchestration — the create/reuse/close/list flow. git runs directly (mocked process
// capability, no plugin dependency); core surface commands are mocked separately. RED baseline: a
// create that does not run git worktree add, a reuse that mints a second worktree, a close that
// leaves a record.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockApp } from "./helpers/mock-app.mjs";
import { mockProcess } from "./helpers/mock-process.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const plugin = (await import("../main.js")).default;

const ok = (data) => ({ ok: true, code: "OK", message: "", data });

// core registry commands (NOT git — git goes through the process capability)
function coreRouter(overrides = {}) {
  const calls = [];
  const defaults = {
    "program.list": () => ok({ programs: [{ id: "terminal-xterm" }, { id: "terminal-ghostty" }] }),
    "project.open": () => ok({ projectId: "t2", spaceId: "c2", panelId: "g2", viewId: "v2" }),
    "state.tree": () => ok({ projects: [{ id: "t2", root: "/repo-wt/feat-login" }] }),
    "project.close": () => ok({}),
    "project.activate": () => ok({}),
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

// git process handler — repo root, branch existence, worktree add/remove/list by argv.
function defaultGit(_cmd, args) {
  if (args[0] === "rev-parse") return { stdout: "/repo\n", code: 0 };
  if (args[0] === "show-ref") return { code: 1 }; // branch absent by default → new branch
  if (args[0] === "worktree" && args[1] === "add") return { code: 0 };
  if (args[0] === "worktree" && args[1] === "remove") return { code: 0 };
  if (args[0] === "worktree" && args[1] === "list") return { stdout: "", code: 0 };
  return { stdout: "", code: 0 };
}

function boot({ core, git } = {}) {
  const r = coreRouter(core);
  const proc = mockProcess(git ?? defaultGit);
  const m = mockApp({ manifest, project: { id: "p1", root: "/repo" }, executeCommand: r.fn, process: proc.api });
  plugin.activate(m.ctx);
  const cmd = (name) => m.registered.get(name).handler;
  return { m, r, proc, cmd };
}
const seed = (m, rec) => m.app.data.put("workspace", rec, { scope: "index", id: rec.slug });

test("worktree.open create — runs git worktree add, opens a project+terminal, persists a record", async () => {
  const { m, r, proc, cmd } = boot();
  const out = await cmd("worktree.open")({ name: "feat/login" });
  assert.equal(out.created, true);
  assert.equal(out.slug, "feat-login");
  assert.equal(out.branch, "feat/login");
  assert.equal(out.worktreeDir, "/repo-wt/feat-login");
  assert.equal(out.project, "t2");
  // git owns the worktree creation — spawned directly, not a plugin call
  const add = proc.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
  assert.ok(add, "git worktree add not spawned");
  assert.ok(add.args.includes("-b"), "a fresh branch is created with -b");
  assert.ok(add.args.includes("feat/login") && add.args.includes("/repo-wt/feat-login"));
  assert.equal(add.opts.cwd, "/repo");
  assert.equal(out.attached, false);
  // no plugin-to-plugin call (coupling 0)
  assert.ok(!r.calls.some((c) => c.name.startsWith("plugin.")), "must not call another plugin");
  // project opened on the worktree with a discovered terminal program
  const po = r.calls.find((c) => c.name === "project.open");
  assert.equal(po.params.root, "/repo-wt/feat-login");
  assert.equal(po.params.program, "terminal-xterm");
  const rows = await m.app.data.query("workspace", { scope: "index" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, "t2");
});

test("worktree.open reuse — a second open of the same slug activates, never runs a second worktree add", async () => {
  const { m, proc, cmd } = boot();
  await seed(m, { slug: "feat-login", branch: "feat/login", repoRoot: "/repo", worktreeDir: "/repo-wt/feat-login", projectId: "t2", windowLabel: "w-a", createdAt: 1 });
  const out = await cmd("worktree.open")({ name: "feat/login" });
  assert.equal(out.reused, true);
  assert.equal(proc.calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "add").length, 0);
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 1);
});

test("worktree.open attach — a surviving branch (no record) attaches a worktree, never re-creates it", async () => {
  // The close⇄open pair: close kept the branch, removed the worktree and record. Opening the same
  // name must attach a worktree to the existing branch (git worktree add <dir> <branch>, no -b).
  const gitAttach = (_c, args) => {
    if (args[0] === "rev-parse") return { stdout: "/repo\n", code: 0 };
    if (args[0] === "show-ref") return { code: 0 }; // branch EXISTS
    if (args[0] === "worktree" && args[1] === "add") return { code: 0 };
    return { code: 0 };
  };
  const { m, proc, cmd } = boot({ git: gitAttach });
  const out = await cmd("worktree.open")({ name: "feat/login" });
  assert.equal(out.created, true);
  assert.equal(out.attached, true);
  const add = proc.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
  assert.ok(!add.args.includes("-b"), "attach must not pass -b (that would try to re-create the branch → fail)");
  assert.ok(add.args.includes("feat/login") && add.args.includes("/repo-wt/feat-login"));
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 1);
});

test("worktree.open — a non-repo path surfaces NOT_REPO, no worktree, no record", async () => {
  const gitNotRepo = (_c, args) =>
    args[0] === "rev-parse" ? { stderr: "fatal: not a git repository", code: 128 } : { code: 0 };
  const { m, proc, cmd } = boot({ git: gitNotRepo });
  const out = await cmd("worktree.open")({ name: "feat/x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "NOT_REPO");
  assert.equal(proc.calls.filter((c) => c.args[1] === "add").length, 0);
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 0);
});

test("worktree.open — an unusable name is INVALID_NAME, never a create", async () => {
  const { cmd } = boot();
  const out = await cmd("worktree.open")({ name: "   " });
  assert.equal(out.ok, false);
  assert.equal(out.code, "INVALID_NAME");
});

test("worktree.close — closes the project, removes the worktree, deletes the record", async () => {
  const { m, r, proc, cmd } = boot();
  await seed(m, { slug: "feat-login", branch: "feat/login", repoRoot: "/repo", worktreeDir: "/repo-wt/feat-login", projectId: "t2", windowLabel: "w-a", createdAt: 1 });
  const out = await cmd("worktree.close")({ name: "feat/login" });
  assert.equal(out.closed, true);
  assert.ok(r.calls.some((c) => c.name === "project.close" && c.params.project === "t2"));
  const rm = proc.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove");
  assert.ok(rm && rm.args.includes("/repo-wt/feat-login"), "git worktree remove not spawned");
  assert.equal((await m.app.data.query("workspace", { scope: "index" })).length, 0);
});

test("worktree.close — an absent workspace is an idempotent no-op", async () => {
  const { cmd } = boot();
  const out = await cmd("worktree.close")({ name: "nope" });
  assert.equal(out.closed, false);
  assert.equal(out.slug, "nope");
});

test("worktree.close — refuses (keeps record) when git reports the worktree still present", async () => {
  const NUL = "\0";
  const gitDirty = (_c, args) => {
    if (args[0] === "rev-parse") return { stdout: "/repo\n", code: 0 };
    if (args[1] === "remove") return { stderr: "contains modified or untracked files", code: 1 };
    if (args[1] === "list") return { stdout: ["worktree /repo-wt/feat-login", "HEAD a"].join(NUL) + NUL + NUL, code: 0 };
    return { code: 0 };
  };
  const { m, cmd } = boot({ git: gitDirty });
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
