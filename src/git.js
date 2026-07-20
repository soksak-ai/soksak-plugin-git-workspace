// The git this plugin needs, taken from the contract — not run here.
//
// A git runner is a spawn wrapper, an env pin, timeouts, a branch-name whitelist and a porcelain
// parser. Every plugin that ran git kept its own copy, and a duplicated defense is a security debt:
// the copy written slightly wrong is the one that ships, and it does not announce itself. Those
// rules are stated and scored once, in soksak-spec-plugin-git. This plugin asks whoever implements it.
//
// The implementer is resolved by contract, never named (C3 L2 contract-pin). The manifest declares
// `consumes: ["soksak-spec-plugin-git"]` and the host's call gate reads that declaration, so no plugin id
// appears here or in the manifest. Swap the implementer and this file does not change.

export const GIT_CONTRACT = "soksak-spec-plugin-git";

// No enabled implementer is a loud refusal. A workspace without git is not an empty workspace list —
// it is a plugin that cannot do its job, and saying so is the only honest answer.
export function noProvider(msg) {
  return {
    ok: false,
    code: "NO_GIT_PROVIDER",
    message: msg(
      `no enabled plugin implements ${GIT_CONTRACT}`,
      `${GIT_CONTRACT} 을 구현한 활성 플러그인이 없습니다`,
    ),
  };
}

// Bind the contract surface to the host. A refusal from the implementer (INVALID_BRANCH, GIT_ERROR,
// …) passes through untouched — this plugin adds no interpretation to a failure it did not cause.
export function makeGit(app, msg) {
  // Resolved on every call: an implementer is enabled and disabled at runtime, so a cached id is a
  // claim about a fact that may already have changed.
  async function provider() {
    const out = await app.commands.execute("plugin.implementers", { id: GIT_CONTRACT });
    if (!out?.ok) return null;
    const found = (out.data?.implementers ?? []).find((i) => i.status === "enabled");
    return found?.id ?? null;
  }

  async function call(cmd, params) {
    const id = await provider();
    if (!id) return noProvider(msg);
    return app.commands.execute(`plugin.${id}.${cmd}`, params);
  }

  return {
    call,

    // Tri-state root discovery. The three states are three, not two: a repository git cannot read is
    // an error, and answering "not-repo" invites the caller to initialize over a broken repository.
    // The refusal's code travels with it: "git failed" and "there is no git" are different facts,
    // and a caller that collapses them tells the user to check a repository that was never read.
    async root(cwd) {
      const out = await call("root", { path: cwd });
      if (!out.ok) return { state: "error", error: out.message, code: out.code };
      return out.data ?? { state: "error", error: "empty answer", code: "GIT_ERROR" };
    },

    // A closed workspace keeps its branch — reopening attaches to it instead of recreating it, which
    // would mean deleting the branch, which is the work.
    async branchExists(repoRoot, branch) {
      const out = await call("branch.exists", { path: repoRoot, branch });
      return out.ok ? out.data?.exists === true : false;
    },

    // The contract answers { dir, branch, base, attached }; a failure is its own envelope.
    async worktreeAdd({ repoRoot, branch, dir, base = "HEAD", attach = false }) {
      const out = await call("worktree.add", { path: repoRoot, branch, dir, base, attach });
      return out.ok ? { ok: true, ...(out.data ?? {}) } : out;
    },

    async worktreeRemove({ repoRoot, dir }) {
      const out = await call("worktree.remove", { path: repoRoot, dir });
      return out.ok ? { ok: true, ...(out.data ?? {}) } : out;
    },

    async worktreeList(repoRoot) {
      const out = await call("worktree.list", { path: repoRoot });
      return out.ok ? { ok: true, ...(out.data ?? {}) } : out;
    },
  };
}
