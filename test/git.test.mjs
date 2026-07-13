// The git seam — this plugin runs no git. It asks whoever implements soksak-spec-plugin-git, and it
// finds that plugin by contract, never by name.
//
// The provider id the tests hand it is deliberately NOT the one that ships: if an implementer's name
// were written anywhere in this plugin, these tests could not pass.
import test from "node:test";
import assert from "node:assert/strict";
import { GIT_CONTRACT, makeGit } from "../src/git.js";

const PROVIDER = "soksak-plugin-any-git";
const ENABLED = [{ id: PROVIDER, version: "1.0.0", status: "enabled" }];
const msg = (en) => en;

// A host that knows the contract: it answers plugin.implementers and routes provider commands.
function hostApp({ implementers = ENABLED, answers = {}, calls = [], discovery = [] } = {}) {
  return {
    commands: {
      async execute(name, params) {
        if (name === "plugin.implementers") {
          discovery.push(params);
          return { ok: true, code: "OK", message: "", data: { implementers } };
        }
        calls.push([name, params]);
        const cmd = name.startsWith(`plugin.${PROVIDER}.`) ? name.slice(`plugin.${PROVIDER}.`.length) : null;
        const answer = cmd && answers[cmd];
        if (typeof answer === "function") return answer(params);
        if (answer) return answer;
        return { ok: true, code: "OK", message: "", data: {} };
      },
    },
  };
}

test("the provider is resolved by contract id, and never named", async () => {
  const calls = [];
  const discovery = [];
  const git = makeGit(hostApp({ calls, discovery }), msg);
  await git.worktreeList("/repo");
  assert.deepEqual(discovery, [{ contract: GIT_CONTRACT }]);
  assert.equal(calls[0][0], `plugin.${PROVIDER}.worktree.list`);
  for (const [name] of calls) assert.ok(!name.includes("git-core"), `an implementer is named: ${name}`);
});

test("no enabled implementer → loud refusal, not an empty workspace list", async () => {
  const git = makeGit(hostApp({ implementers: [] }), msg);
  for (const out of [
    await git.worktreeList("/repo"),
    await git.worktreeAdd({ repoRoot: "/repo", branch: "feat/x", dir: "/wt" }),
    await git.worktreeRemove({ repoRoot: "/repo", dir: "/wt" }),
  ]) {
    assert.equal(out.ok, false);
    assert.equal(out.code, "NO_GIT_PROVIDER");
    assert.ok(out.message.includes(GIT_CONTRACT));
  }
  assert.equal(await git.branchExists("/repo", "feat/x"), false);

  // A disabled implementer is not a provider either.
  const disabled = makeGit(hostApp({ implementers: [{ id: PROVIDER, status: "disabled" }] }), msg);
  assert.equal((await disabled.worktreeList("/repo")).code, "NO_GIT_PROVIDER");
});

test("root — the contract's tri-state passes through, and a refusal becomes error (never not-repo)", async () => {
  const repo = makeGit(hostApp({ answers: { root: { ok: true, data: { state: "repo", root: "/repo" } } } }), msg);
  assert.deepEqual(await repo.root("/repo/sub"), { state: "repo", root: "/repo" });

  const plain = makeGit(hostApp({ answers: { root: { ok: true, data: { state: "not-repo" } } } }), msg);
  assert.deepEqual(await plain.root("/tmp"), { state: "not-repo" });

  // A broken repository must never come back as "not-repo" — that is how a caller ends up
  // initializing a repository on top of one git could not read.
  const broken = makeGit(
    hostApp({ answers: { root: { ok: false, code: "GIT_ERROR", message: "invalid gitfile format" } } }),
    msg,
  );
  const out = await broken.root("/broken");
  assert.equal(out.state, "error");
  assert.equal(out.error, "invalid gitfile format");
});

test("worktree.add — attach is passed through (reopening keeps the branch that carries the work)", async () => {
  const calls = [];
  const git = makeGit(
    hostApp({
      calls,
      answers: {
        "worktree.add": (p) => ({ ok: true, data: { dir: p.dir, branch: p.branch, base: null, attached: true } }),
      },
    }),
    msg,
  );
  const out = await git.worktreeAdd({ repoRoot: "/repo", branch: "feat/x", dir: "/wt/feat-x", attach: true });
  assert.equal(out.ok, true);
  assert.equal(out.attached, true);
  assert.deepEqual(calls[0][1], { path: "/repo", branch: "feat/x", dir: "/wt/feat-x", base: "HEAD", attach: true });
});

test("branch.exists — an answer, and a refusal is not an existence claim", async () => {
  const yes = makeGit(hostApp({ answers: { "branch.exists": { ok: true, data: { exists: true } } } }), msg);
  assert.equal(await yes.branchExists("/repo", "feat/x"), true);
  const no = makeGit(hostApp({ answers: { "branch.exists": { ok: true, data: { exists: false } } } }), msg);
  assert.equal(await no.branchExists("/repo", "no/such"), false);
  const refused = makeGit(
    hostApp({ answers: { "branch.exists": { ok: false, code: "INVALID_BRANCH", message: "no" } } }),
    msg,
  );
  assert.equal(await refused.branchExists("/repo", "-x"), false);
});

test("the implementer's refusal passes through untouched (this plugin adds no interpretation)", async () => {
  const git = makeGit(
    hostApp({ answers: { "worktree.add": { ok: false, code: "INVALID_BRANCH", message: "invalid branch name" } } }),
    msg,
  );
  const out = await git.worktreeAdd({ repoRoot: "/repo", branch: "-x", dir: "/wt" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "INVALID_BRANCH");
  assert.equal(out.message, "invalid branch name");
});
