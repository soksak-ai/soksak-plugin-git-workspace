// Pure decision logic — no host, no git. The seam the unit tests exercise.
//   normalizeBranch : a free-form name or issue slug → a valid git branch name (or null)
//   slugKey         : a branch → a stable address-safe id (data-node segment, record id)
//   planOpen        : given existing records + input, decide create vs reuse (idempotency)
//   deriveViewStatus: a load outcome → the view's status{code,message} axis

// Turn a free-form input (a branch name or an issue slug) into a valid git branch
// name, or null when nothing usable remains. Sanitizes rather than rejects so an
// issue title ("Fix: the thing") becomes a branch ("Fix-the-thing"). The final
// guard matches git's own ref-name rule so what we return, git accepts.
export function normalizeBranch(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/\s+/g, "-"); // whitespace → hyphen
  s = s.replace(/[^A-Za-z0-9._/-]+/g, "-"); // drop everything git disallows
  s = s.replace(/-{2,}/g, "-"); // collapse hyphen runs
  s = s.replace(/\/{2,}/g, "/"); // collapse slash runs
  s = s.replace(/\.{2,}/g, "."); // no ".." (git ref rule)
  s = s.replace(/^[^A-Za-z0-9]+/, ""); // must start alphanumeric
  s = s.replace(/[/.-]+$/, ""); // no trailing slash/dot/hyphen
  if (s.endsWith(".lock")) s = s.slice(0, -5).replace(/[/.-]+$/, "");
  if (!s) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s)) return null;
  if (s.includes("..") || s.endsWith("/") || s.endsWith(".")) return null;
  return s;
}

// A branch → a stable id usable both as a record id and as a node-path segment
// (^[a-z0-9][a-z0-9.-]*$). Lowercase, slashes and other separators become hyphens.
// The id is derived from the branch (a stable identifier), never a counter.
export function slugKey(branch) {
  const k = String(branch)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : "w-" + k;
}

// Given the existing workspace records and an input, decide the action. Reuse when a
// record with the same slug already exists (idempotency: a second open focuses the
// existing window, it does not mint a second workspace); create otherwise; invalid
// when the input yields no usable branch name.
export function planOpen(records, input) {
  const branch = normalizeBranch(input);
  if (!branch) return { action: "invalid" };
  const slug = slugKey(branch);
  const record = (Array.isArray(records) ? records : []).find((r) => r && r.slug === slug) || null;
  if (record) return { action: "reuse", branch, slug, record };
  return { action: "create", branch, slug };
}

// The view's status axis (C2 transparency). This is a read/manage panel — none of its
// states are blocking (no dirty/busy/running), so every code is display-only. message
// resolves locale via the injected msg. An unknown kind is null (no forced status).
export function deriveViewStatus(outcome, msg) {
  switch (outcome.kind) {
    case "loading":
      return { code: "loading", message: msg("Loading…", "불러오는 중…") };
    case "empty":
      return { code: "empty", message: msg("No workspaces", "워크스페이스 없음") };
    case "active":
      return {
        code: "active",
        message: msg(`${outcome.count} workspace(s)`, `워크스페이스 ${outcome.count}개`),
      };
    case "error":
      return { code: "error", message: outcome.message };
    default:
      return null;
  }
}
