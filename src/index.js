// soksak-plugin-git-workspace — worktree workspaces (branch + worktree + surface + terminal).
// Owns its git execution: worktree add/remove/list and repository-root discovery run the git CLI
// directly through the process capability (no dependency on another plugin — coupling 0). The
// workspace surface is a project opened on the worktree with a terminal as its first view
// (cwd = the worktree), driven through core registry commands. Workspace records persist in the
// core data store ("data" permission). External data (paths/branches) is inserted with
// textContent only — no innerHTML for content.
import { normalizeBranch, slugKey, planOpen, deriveViewStatus } from "./plan.js";
import { makeGit } from "./git.js";

const COLL = "workspace";
const SCOPE = "index"; // one partition — a global registry of open worktree workspaces

// Element helper — text is textContent only (escaping guaranteed).
function h(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Last path segment (repo/worktree display name). Never used as an address key.
function baseName(p) {
  return String(p ?? "").replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? String(p ?? "");
}

const index_default = {
  activate(ctx) {
    const app = ctx.app;
    const err = (code, message) => ({ ok: false, code, message });
    // message resolves to the host language (docs/I18N.md — human surface {en,ko}).
    const msg = (en, ko) => ((typeof app.locale === "function" ? app.locale() : "en") === "ko" ? ko : en);
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    const git = makeGit(app.process); // git CLI, run directly (coupling 0)

    void app.data.define(COLL, { indexes: ["slug", "repoRoot", "windowLabel", "createdAt"] });

    const loadRecords = async () => {
      const rows = await app.data.query(COLL, { scope: SCOPE, order: "createdAt" });
      return Array.isArray(rows) ? rows : [];
    };
    const publicRecord = (r) => ({
      slug: r.slug,
      branch: r.branch,
      worktreeDir: r.worktreeDir,
      windowLabel: r.windowLabel,
      projectId: r.projectId,
      repoRoot: r.repoRoot,
      createdAt: r.createdAt,
    });

    // Resolve the repository root a workspace belongs to (git rev-parse). A non-repo path or a
    // git error surfaces as a failure envelope (no silent swallow).
    async function resolveRepoRoot(repoPath) {
      if (!repoPath) {
        return { ok: false, out: err("NO_PATH", msg("no repository path — pass path or open a project", "저장소 경로 없음 — path 를 주거나 프로젝트를 여세요")) };
      }
      const st = await git.root(repoPath);
      if (st.state === "repo") return { ok: true, root: st.root };
      if (st.state === "not-repo") {
        return { ok: false, out: err("NOT_REPO", msg("not a git repository", "git 저장소가 아닙니다")) };
      }
      return { ok: false, out: err("GIT_ERROR", st.error || msg("git error", "git 오류")) };
    }

    // Engine-neutral terminal program (the terminal is a replaceable seam — NAMING §4). Discover
    // an installed terminal program instead of pinning one engine; prefer the default xterm.
    async function resolveTerminalProgram() {
      const out = await app.commands.execute("program.list");
      const ids = out.ok
        ? (out.data?.programs ?? []).map((p) => p.id).filter((id) => typeof id === "string" && id.startsWith("terminal-"))
        : [];
      return ids.includes("terminal-xterm") ? "terminal-xterm" : ids[0] || "terminal-xterm";
    }

    // ── worktree.open — the one-shot ────────────────────────────────────────────
    reg("worktree.open", {
      description:
        "Open a worktree workspace. Given a branch name or issue slug, create the branch and a git worktree, then open a project on the worktree with a terminal as its first view (cwd = the worktree). Idempotent: opening a workspace that already exists activates it instead of creating a second one.",
      triggers: { ko: "워크트리 워크스페이스 열기 브랜치 새 작업 생성 워크트리" },
      params: {
        name: { type: "string", description: "Branch name or issue slug for the workspace", required: true },
        path: { type: "string", description: "Repository directory the worktree branches from (defaults to the active project root)" },
        base: { type: "string", description: "Base ref for the new branch (default HEAD)" },
      },
      returns: "{ slug, branch, worktreeDir, project, window, created|reused }",
      examples: [
        'sok plugin.soksak-plugin-git-workspace.worktree.open \'{"name":"feat/login"}\'',
        'sok plugin.soksak-plugin-git-workspace.worktree.open \'{"name":"issue-42","base":"main"}\'',
      ],
      message: (d) =>
        d.reused
          ? msg(`Activated workspace ${d.branch}`, `워크스페이스 ${d.branch} 활성화`)
          : msg(`Opened workspace ${d.branch}`, `워크스페이스 ${d.branch} 열기`),
      hint: (d) =>
        d.ok === false
          ? []
          : [{ cmd: "plugin.soksak-plugin-git-workspace.worktree.list", why: msg("see all open workspaces", "열린 워크스페이스 전체를 봅니다") }],
      handler: async (p) => {
        const repoPath = (typeof p.path === "string" && p.path ? p.path : undefined) ?? app.project?.current?.()?.root ?? undefined;
        const rr = await resolveRepoRoot(repoPath);
        if (!rr.ok) return rr.out;
        const repoRoot = rr.root;

        const records = await loadRecords();
        const plan = planOpen(records, p.name);
        if (plan.action === "invalid") {
          return err("INVALID_NAME", msg("name yields no usable branch", "name 에서 유효한 브랜치명을 만들 수 없습니다"));
        }

        const termProgram = await resolveTerminalProgram();

        if (plan.action === "reuse") {
          const record = plan.record;
          // project.open dedups on root: an already-open worktree is activated, a closed one reopened.
          const po = await app.commands.execute("project.open", { root: record.worktreeDir, program: termProgram });
          const projectId = po.ok ? po.data?.projectId ?? record.projectId : record.projectId;
          const windowLabel = po.ok && po.data?.existingWindow ? po.data.existingWindow : app.windowLabel?.() ?? record.windowLabel;
          if (projectId !== record.projectId || windowLabel !== record.windowLabel) {
            await app.data.put(COLL, { ...record, projectId, windowLabel }, { scope: SCOPE, id: record.slug });
          }
          app.activity.publish("workspace.open", {
            message: msg(`Activated workspace ${record.branch}`, `워크스페이스 ${record.branch} 활성화`),
            slug: record.slug,
            branch: record.branch,
          });
          return { reused: true, slug: record.slug, branch: record.branch, worktreeDir: record.worktreeDir, project: projectId, window: windowLabel };
        }

        // create: branch + worktree (git run directly), then a project + terminal on it
        const dir = `${repoRoot}-wt/${plan.slug}`;
        const add = await git.worktreeAdd({
          repoRoot,
          branch: plan.branch,
          dir,
          base: typeof p.base === "string" && p.base ? p.base : "HEAD",
        });
        if (!add.ok) return err(add.code, add.message); // propagate git failure (no silent swallow)

        const po = await app.commands.execute("project.open", { root: dir, program: termProgram });
        if (!po.ok) return err(po.code, po.message);
        const projectId = po.data?.projectId ?? null;
        const windowLabel = po.data?.routedWindow || po.data?.existingWindow || app.windowLabel?.() || null;

        const rec = {
          slug: plan.slug,
          branch: add.branch ?? plan.branch,
          base: add.base ?? null,
          repoRoot,
          worktreeDir: dir,
          projectId,
          windowLabel,
          createdAt: Date.now(),
        };
        await app.data.put(COLL, rec, { scope: SCOPE, id: plan.slug });
        app.activity.publish("workspace.open", {
          message: msg(`Opened workspace ${rec.branch}`, `워크스페이스 ${rec.branch} 열기`),
          slug: rec.slug,
          branch: rec.branch,
        });
        return { created: true, slug: rec.slug, branch: rec.branch, worktreeDir: dir, project: projectId, window: windowLabel };
      },
    });

    // ── worktree.close — reclaim (surface + worktree; branch/commits survive) ────
    reg("worktree.close", {
      description:
        "Close a worktree workspace: close its project surface and remove the worktree checkout. The branch and its commits are not touched. Idempotent — an absent workspace is a no-op. Refuses when the worktree has uncommitted changes (git's protection); commit or discard first.",
      triggers: { ko: "워크트리 워크스페이스 닫기 회수 워크트리 제거" },
      params: {
        name: { type: "string", description: "The same branch name or slug used to open the workspace", required: true },
      },
      returns: "{ closed, slug, branch?, worktreeDir? }",
      examples: ['sok plugin.soksak-plugin-git-workspace.worktree.close \'{"name":"feat/login"}\''],
      message: (d) =>
        d.closed
          ? msg(`Closed workspace ${d.branch ?? d.slug}`, `워크스페이스 ${d.branch ?? d.slug} 닫기`)
          : msg(`No such workspace ${d.slug}`, `워크스페이스 ${d.slug} 없음`),
      handler: async (p) => {
        const raw = typeof p.name === "string" ? p.name : "";
        const slug = slugKey(normalizeBranch(raw) || raw);
        const records = await loadRecords();
        const record = records.find((r) => r.slug === slug);
        if (!record) return { closed: false, slug }; // idempotent no-op

        // Close the project surface first (terminates its terminal), then remove the worktree.
        // Resolve the project by its root in this window — robust against id drift (reload/reseed).
        let projectId = record.projectId;
        const tree = await app.commands.execute("state.tree");
        if (tree.ok) {
          const proj = (tree.data?.projects ?? []).find((pr) => pr.root === record.worktreeDir);
          if (proj) projectId = proj.id;
        }
        if (projectId) await app.commands.execute("project.close", { project: projectId });

        const rm = await git.worktreeRemove({ repoRoot: record.repoRoot, dir: record.worktreeDir });
        if (!rm.ok) {
          // Already gone (removed out-of-band) counts as reclaimed; otherwise surface the reason.
          const wl = await git.worktreeList(record.repoRoot);
          const stillThere = wl.ok && wl.worktrees.some((w) => w.path === record.worktreeDir);
          if (stillThere) return err(rm.code, rm.message); // dirty/locked — record kept
        }
        await app.data.delete(COLL, slug, { scope: SCOPE });
        app.activity.publish("workspace.close", {
          message: msg(`Closed workspace ${record.branch}`, `워크스페이스 ${record.branch} 닫기`),
          slug,
          branch: record.branch,
        });
        return { closed: true, slug, branch: record.branch, worktreeDir: record.worktreeDir };
      },
    });

    // ── worktree.list — the status/pull surface (same records the view shows) ────
    reg("worktree.list", {
      description:
        "List active worktree workspaces — the same records the Workspaces view shows: slug, branch, worktree directory, hosting window and project, and origin repository.",
      triggers: { ko: "워크트리 워크스페이스 목록 조회 상태" },
      params: {},
      returns: "{ workspaces: [{slug, branch, worktreeDir, windowLabel, projectId, repoRoot, createdAt}] }",
      examples: ["sok plugin.soksak-plugin-git-workspace.worktree.list"],
      message: (d) => msg(`${(d.workspaces ?? []).length} workspace(s)`, `워크스페이스 ${(d.workspaces ?? []).length}개`),
      handler: async () => ({ workspaces: (await loadRecords()).map(publicRecord) }),
    });

    // ── The view (DOM trio) ─────────────────────────────────────────────────────
    const cleanups = new Map();
    ctx.subscriptions.push(
      app.ui.registerView("view", {
        mount(container, vctx) {
          const report = (outcome) => vctx.setStatus?.(deriveViewStatus(outcome, msg));
          container.replaceChildren();
          const wrap = h(
            "div",
            "display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--fg);background:var(--bg)",
          );

          const bar = h(
            "div",
            "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
              "padding:4px 10px;border-bottom:1px solid var(--bd);flex:0 0 auto;min-height:28px;box-sizing:border-box",
          );
          const title = h("span", "color:var(--fg2)", msg("Workspaces", "워크스페이스"));
          const refreshBtn = h(
            "button",
            "display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;padding:0;cursor:pointer;" +
              "border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px",
          );
          refreshBtn.textContent = "⟳";
          refreshBtn.title = msg("Refresh", "새로고침");
          refreshBtn.dataset.node = "refresh";
          bar.append(title, refreshBtn);

          const errEl = h(
            "div",
            "display:none;padding:8px 10px;color:var(--danger);font-size:11px;white-space:pre-wrap;word-break:break-all;flex:0 0 auto",
          );
          const listEl = h("div", "flex:1 1 auto;min-height:0;overflow:auto;padding:5px 0");
          wrap.append(bar, errEl, listEl);
          container.append(wrap);

          const showError = (text) => {
            errEl.textContent = String(text);
            errEl.style.display = "block";
            report({ kind: "error", message: String(text) });
          };

          async function renderList() {
            errEl.style.display = "none";
            listEl.replaceChildren();
            report({ kind: "loading" });
            let records;
            try {
              records = await loadRecords();
            } catch (e) {
              showError(e && e.message ? e.message : e);
              return;
            }
            if (records.length === 0) {
              listEl.append(h("div", "padding:6px 12px;color:var(--fg3)", msg("No workspaces", "워크스페이스 없음")));
              report({ kind: "empty" });
              return;
            }
            report({ kind: "active", count: records.length });
            const frag = document.createDocumentFragment();
            for (const r of records) {
              const row = h("div", "display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer");
              row.title = `${r.branch}  ·  ${r.worktreeDir}`;
              row.dataset.node = `row/${r.slug}`; // click = focus its window / activate its project
              const branchEl = h("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)", r.branch);
              const repoEl = h("span", "flex:0 0 auto;color:var(--fg3);font-size:11px", baseName(r.repoRoot));
              const closeBtn = h(
                "button",
                "flex:0 0 auto;width:18px;height:18px;padding:0;cursor:pointer;border:1px solid var(--bd);" +
                  "background:transparent;color:var(--fg3);border-radius:4px;line-height:1",
              );
              closeBtn.textContent = "×";
              closeBtn.title = msg("Close workspace", "워크스페이스 닫기");
              closeBtn.dataset.node = `close/${r.slug}`;
              closeBtn.onclick = (ev) => {
                ev.stopPropagation();
                void app.commands.execute("plugin.soksak-plugin-git-workspace.worktree.close", { name: r.slug });
              };
              row.onclick = () => {
                if (r.windowLabel) void app.commands.execute("window.focus", { label: r.windowLabel });
                if (r.projectId) void app.commands.execute("project.activate", { project: r.projectId });
              };
              row.append(branchEl, repoEl, closeBtn);
              frag.append(row);
            }
            listEl.append(frag);
          }

          refreshBtn.onclick = () => void renderList();
          void renderList();

          // Event-driven refresh (no polling): the core fires data-change across every window on
          // any put/delete in this ns/collection — an open/close from any window updates here.
          const sub = app.data.watch(COLL, { scope: SCOPE }, () => void renderList());
          cleanups.set(container, () => sub.dispose());
        },
        unmount(container) {
          cleanups.get(container)?.();
          cleanups.delete(container);
          container.replaceChildren();
        },
      }),
    );
  },

  deactivate() {
    // registered resources are collected by the host tracker + ctx.subscriptions
  },
};

export { index_default as default };
