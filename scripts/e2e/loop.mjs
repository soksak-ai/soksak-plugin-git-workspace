#!/usr/bin/env node
// End-to-end gate for soksak-plugin-git-workspace, driven only through registry commands (sok).
// Idempotent: a fixture repo under ~/.soksak-e2e, and every run pre-reclaims its own leftovers.
// Gates: ① worktree.open one-shot (branch + worktree + project surface + terminal cwd), 2x idempotent
//        ② worktree.close reclaims (worktree, surface, record all gone)
//        ③ the plugin's nodes are exposed in ui.tree and one is clickable
//        (⑤ a window snapshot is written for eye verification)
//
// Env: SOK = the sok binary (default: the pinned debug CLI). Requires the target app running.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { join } from "node:path";

const SOK = process.env.SOK || "/Users/max/ai/cli/vsterm-tauri/src-tauri/target/debug/sok-debug";
const FIXTURE = join(homedir(), ".soksak-e2e", "git-workspace");
const REPO = join(FIXTURE, "repo");
const NAME = "e2e/feature";
const SLUG = "e2e-feature";
const BRANCH = "e2e/feature";
const WT = `${REPO}-wt/e2e-feature`;
const SNAP = join(FIXTURE, "snapshot.png");
const PLUGIN = "plugin.soksak-plugin-git-workspace";

function sok(cmd, params, opts = {}) {
  const args = [];
  if (opts.window) args.push("--window", opts.window);
  args.push(cmd);
  if (params !== undefined) args.push(JSON.stringify(params));
  const r = spawnSync(SOK, args, { encoding: "utf8", timeout: 30000 });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`sok ${cmd} — non-JSON output: ${r.stdout || r.stderr}`);
  }
  return out;
}
function git(args) {
  return spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
}
const step = (n, s) => console.log(`\n[${n}] ${s}`);

function ensureFixture() {
  if (!existsSync(join(REPO, ".git"))) {
    mkdirSync(REPO, { recursive: true });
    for (const a of [["init", "-b", "main"], ["config", "user.email", "e2e@soksak.test"], ["config", "user.name", "e2e"]]) git(a);
    spawnSync("bash", ["-c", `printf 'hello\\n' > ${JSON.stringify(join(REPO, "README.md"))}`]);
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "init fixture"]);
  }
}

async function main() {
  step("setup", "ensure the app is up and the fixture repo exists");
  const wl = sok("window.list");
  assert.ok(wl.ok, `app not reachable via ${SOK}: ${wl.message ?? "no response"}`);
  ensureFixture();

  step("window", "open the repo in its own window");
  const wo = sok("window.open", { root: REPO });
  assert.ok(wo.ok, `window.open: ${wo.message}`);
  const repoWin = wo.data.label || wo.data.existingWindow;
  assert.ok(repoWin, "no repo window label");

  step("view", "open the Workspaces view in the repo window (so ui.tree exposes it)");
  sok("plugin.view.open", { view: "soksak-plugin-git-workspace.view", placement: "sidebar-right" }, { window: repoWin });

  step("pre-clean", "reclaim any leftover from a prior run (idempotent)");
  sok(`${PLUGIN}.worktree.close`, { name: NAME }, { window: repoWin });
  git(["worktree", "remove", "--force", WT]);
  git(["worktree", "prune"]);
  if (existsSync(WT)) rmSync(WT, { recursive: true, force: true });
  git(["branch", "-D", BRANCH]);

  // ── GATE ① create ──────────────────────────────────────────────────────────
  step("①.create", "worktree.open — one command → branch + worktree + project + terminal");
  const o1 = sok(`${PLUGIN}.worktree.open`, { name: NAME, path: REPO }, { window: repoWin });
  assert.ok(o1.ok, `worktree.open failed: ${o1.code} ${o1.message}`);
  assert.equal(o1.data.created, true, "first open must create");
  assert.equal(o1.data.slug, SLUG);
  assert.equal(o1.data.worktreeDir, WT);
  assert.ok(o1.data.project, "no project id returned");

  assert.ok(git(["branch", "--list", BRANCH]).stdout.trim(), "branch not created");
  assert.ok(git(["worktree", "list", "--porcelain"]).stdout.includes(WT), "worktree not created");

  const tree1 = sok("state.tree", undefined, { window: repoWin });
  const wtProject = tree1.data.projects.find((p) => p.root === WT);
  assert.ok(wtProject, "no project surface rooted at the worktree");

  step("①.cwd", "the seeded terminal is rooted at the worktree");
  // Target the worktree project's own terminal pane (a terminal view's id is its pane id) —
  // deterministic, not the ambiguous "active" terminal.
  const wtSpace = wtProject.spaces.find((s) => s.id === wtProject.activeSpaceId) || wtProject.spaces[0];
  const wtView = wtSpace.panels.flatMap((pn) => pn.views).find((v) => v.kind === "plugin");
  assert.ok(wtView, "no terminal view in the worktree project");
  const pane = wtView.id;
  sok("term.exec", { pane, cmd: "pwd -P" }, { window: repoWin });
  await new Promise((r) => setTimeout(r, 1500));
  const read = sok("term.read", { pane, lines: 8 }, { window: repoWin });
  assert.ok(String(read.data.text).includes(WT), `terminal cwd not the worktree:\n${read.data.text}`);

  // ── GATE ① idempotent ───────────────────────────────────────────────────────
  step("①.idempotent", "a second identical open reuses — no second worktree, no second record");
  const o2 = sok(`${PLUGIN}.worktree.open`, { name: NAME, path: REPO }, { window: repoWin });
  assert.ok(o2.ok, `second open failed: ${o2.message}`);
  assert.equal(o2.data.reused, true, "second open must reuse");
  const list1 = sok(`${PLUGIN}.worktree.list`, {}, { window: repoWin });
  assert.equal(list1.data.workspaces.length, 1, "must be exactly one workspace after a 2x open");
  const wtCount = git(["worktree", "list"]).stdout.split("\n").filter((l) => l.includes("e2e-feature")).length;
  assert.equal(wtCount, 1, "must be exactly one worktree after a 2x open");

  // ── GATE ③ ui.tree + click ───────────────────────────────────────────────────
  step("③.ui.tree", "the plugin's nodes are exposed and one is clickable");
  const tree = sok("ui.tree", undefined, { window: repoWin });
  const addrs = (tree.data.nodes || tree.data || []).map((n) => n.address || n);
  const refresh = addrs.find((a) => typeof a === "string" && a.endsWith("/node/refresh"));
  const rowNode = addrs.find((a) => typeof a === "string" && a.includes(`/node/row/${SLUG}`));
  assert.ok(refresh, `no refresh node exposed. addresses:\n${addrs.filter((a) => String(a).includes("git-workspace")).join("\n")}`);
  assert.ok(rowNode, `no workspace row node exposed for ${SLUG}`);
  const click = sok("ui.input.click", { address: refresh }, { window: repoWin });
  assert.ok(click.ok, `refresh click failed: ${click.message}`);

  // ── GATE ⑤ snapshot ───────────────────────────────────────────────────────────
  step("⑤.snapshot", `capture the repo window → ${SNAP}`);
  const snap = sok("window.snapshot", { path: SNAP }, { window: repoWin });
  assert.ok(snap.ok, `snapshot failed: ${snap.message}`);

  // ── GATE ② close ──────────────────────────────────────────────────────────────
  step("②.close", "worktree.close — reclaim window surface, worktree, and record");
  const c1 = sok(`${PLUGIN}.worktree.close`, { name: NAME }, { window: repoWin });
  assert.ok(c1.ok, `worktree.close failed: ${c1.code} ${c1.message}`);
  assert.equal(c1.data.closed, true);
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(!git(["worktree", "list"]).stdout.includes(WT), "worktree not reclaimed");
  assert.ok(!existsSync(WT), "worktree dir still present");
  const tree2 = sok("state.tree", undefined, { window: repoWin });
  assert.ok(!tree2.data.projects.some((p) => p.root === WT), "project surface not reclaimed");
  const list2 = sok(`${PLUGIN}.worktree.list`, {}, { window: repoWin });
  assert.equal(list2.data.workspaces.length, 0, "record not reclaimed");

  step("②.idempotent", "closing again is a no-op");
  const c2 = sok(`${PLUGIN}.worktree.close`, { name: NAME }, { window: repoWin });
  assert.ok(c2.ok && c2.data.closed === false, "second close must be a no-op");

  console.log(`\nALL GATES PASSED. snapshot: ${SNAP}`);
}

main().catch((e) => {
  console.error(`\nE2E FAILED: ${e.message}`);
  process.exit(1);
});
