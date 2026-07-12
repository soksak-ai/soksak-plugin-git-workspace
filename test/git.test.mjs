// git runner pure parts — worktree porcelain parse + branch-name guard.
// RED baseline: a mis-parsed porcelain block, a branch name git would reject slipping through.
import test from "node:test";
import assert from "node:assert/strict";
import { parseWorktreeList, validBranchName } from "../src/git.js";

test("parseWorktreeList — NUL porcelain blocks (branch stripped of refs/heads/)", () => {
  const NUL = "\0";
  const out =
    ["worktree /w/main", "HEAD 1111", "branch refs/heads/main"].join(NUL) + NUL + NUL +
    ["worktree /w/feat", "HEAD 2222", "branch refs/heads/feat/x"].join(NUL) + NUL + NUL +
    ["worktree /w/det", "HEAD 3333", "detached"].join(NUL) + NUL + NUL;
  const list = parseWorktreeList(out);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { path: "/w/main", head: "1111", branch: "main" });
  assert.deepEqual(list[1], { path: "/w/feat", head: "2222", branch: "feat/x" });
  assert.deepEqual(list[2], { path: "/w/det", head: "3333", detached: true });
});

test("parseWorktreeList — locked/prunable attributes carry through", () => {
  const NUL = "\0";
  const out =
    ["worktree /w/lock", "HEAD 44", "branch refs/heads/b", "locked reason text"].join(NUL) + NUL + NUL +
    ["worktree /w/gone", "HEAD 55", "detached", "prunable gitdir missing"].join(NUL) + NUL + NUL;
  const list = parseWorktreeList(out);
  assert.equal(list[0].locked, "reason text");
  assert.equal(list[1].prunable, "gitdir missing");
});

test("validBranchName — accepts real branches, rejects git-illegal ones", () => {
  for (const b of ["feat/login", "release-1.2.0", "a", "x/y/z"]) assert.ok(validBranchName(b), b);
  for (const b of ["", "-lead", "a..b", "trail/", "trail.", "x.lock", 42]) assert.ok(!validBranchName(b), String(b));
});
