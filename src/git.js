// Own the git execution — the git CLI is a stable contract, run directly through the process
// capability. No dependency on another plugin (coupling 0 is the v1 standard). This is the thin
// runner this plugin needs (root discovery + worktree add/remove/list); it is self-owned.

const READ_ENV = Object.freeze({ LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" });
const WRITE_ENV = Object.freeze({ LC_ALL: "C", LANG: "C" });
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 180_000;
const NOT_REPO_RE = /not a git repository/i;

// A branch name git will accept: starts alphanumeric, no "..", no trailing slash/dot, no ".lock".
export function validBranchName(b) {
  if (typeof b !== "string" || b.length === 0) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b)) return false;
  if (b.includes("..") || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock")) return false;
  return true;
}

// Parse `git worktree list --porcelain -z`: NUL-separated records, blank record ends a block.
export function parseWorktreeList(stdout) {
  const list = [];
  let cur = null;
  for (const rec of String(stdout).split("\0")) {
    if (rec === "") {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    const sp = rec.indexOf(" ");
    const key = sp < 0 ? rec : rec.slice(0, sp);
    const val = sp < 0 ? undefined : rec.slice(sp + 1);
    if (key === "worktree") {
      if (cur) list.push(cur);
      cur = { path: val ?? "" };
    } else if (cur) {
      if (key === "HEAD") cur.head = val ?? "";
      else if (key === "branch") cur.branch = (val ?? "").replace(/^refs\/heads\//, "");
      else if (key === "detached") cur.detached = true;
      else if (key === "bare") cur.bare = true;
      else if (key === "locked") cur.locked = val ?? "";
      else if (key === "prunable") cur.prunable = val ?? "";
    }
  }
  if (cur) list.push(cur);
  return list;
}

// git failure → canonical envelope (MESSAGE-PROTOCOL); git's own stderr is the cause (not masked).
function gitFail(r) {
  return { ok: false, code: "GIT_ERROR", message: r.stderr || `git exit ${r.code}` };
}

// Bind the runner to a process capability (app.process). Returns the git operations this plugin
// needs. Each resolves { ok, ... } — a failure is { ok:false, code, message }.
export function makeGit(processApi) {
  function run({ cwd, args, write = false, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? (write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
      const dec = new TextDecoder();
      let out = "";
      let err = "";
      let done = false;
      let timer = null;
      processApi
        .spawn("git", args, { cwd, env: write ? { ...WRITE_ENV } : { ...READ_ENV } })
        .then((handle) => {
          const subs = [];
          const finish = (fn, v) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            for (const s of subs) s.dispose();
            fn(v);
          };
          timer = setTimeout(() => {
            void processApi.kill(handle);
            finish(reject, new Error(`git ${args[0] ?? ""} timeout ${limit}ms`));
          }, limit);
          subs.push(
            processApi.onData(handle, (b) => (out += dec.decode(b, { stream: true }))),
            processApi.onStderr(handle, (b) => (err += new TextDecoder().decode(b))),
            processApi.onExit(handle, (code) => finish(resolve, { code, stdout: out, stderr: err.trim() })),
          );
        })
        .catch((e) => {
          if (!done) {
            done = true;
            if (timer) clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
    });
  }

  return {
    run,
    // Tri-state repository root discovery: repo (with root), not-repo, or error.
    async root(cwd) {
      try {
        const r = await run({ cwd, args: ["rev-parse", "--show-toplevel"] });
        if (r.code === 0) return { state: "repo", root: r.stdout.trim() };
        if (NOT_REPO_RE.test(r.stderr)) return { state: "not-repo" };
        return { state: "error", error: r.stderr };
      } catch (e) {
        return { state: "error", error: String(e?.message ?? e) };
      }
    },
    // Does a local branch already exist? (a closed workspace keeps its branch — reopening attaches.)
    async branchExists(repoRoot, branch) {
      const r = await run({ cwd: repoRoot, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`] });
      return r.code === 0;
    },
    // Add a worktree. New branch by default (-b … base); when attach=true, check out an existing
    // branch instead (git worktree add <dir> <branch>). Failure is the canonical envelope.
    async worktreeAdd({ repoRoot, branch, dir, base = "HEAD", attach = false }) {
      const args = attach
        ? ["worktree", "add", "--", dir, branch]
        : ["worktree", "add", "--no-track", "-b", branch, "--", dir, base];
      const r = await run({ cwd: repoRoot, args, write: true });
      if (r.code !== 0) return gitFail(r);
      return { ok: true, dir, branch, base: attach ? null : base, attached: attach };
    },
    // Remove a worktree checkout (git refuses when it has uncommitted changes — the branch survives).
    async worktreeRemove({ repoRoot, dir }) {
      const r = await run({ cwd: repoRoot, args: ["worktree", "remove", "--", dir], write: true });
      if (r.code !== 0) return gitFail(r);
      return { ok: true, removed: dir };
    },
    async worktreeList(repoRoot) {
      const r = await run({ cwd: repoRoot, args: ["worktree", "list", "--porcelain", "-z"] });
      if (r.code !== 0) return gitFail(r);
      return { ok: true, worktrees: parseWorktreeList(r.stdout) };
    },
  };
}
