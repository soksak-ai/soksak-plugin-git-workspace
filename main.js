// src/plan.js
function normalizeBranch(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/\s+/g, "-");
  s = s.replace(/[^A-Za-z0-9._/-]+/g, "-");
  s = s.replace(/-{2,}/g, "-");
  s = s.replace(/\/{2,}/g, "/");
  s = s.replace(/\.{2,}/g, ".");
  s = s.replace(/^[^A-Za-z0-9]+/, "");
  s = s.replace(/[/.-]+$/, "");
  if (s.endsWith(".lock")) s = s.slice(0, -5).replace(/[/.-]+$/, "");
  if (!s) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s)) return null;
  if (s.includes("..") || s.endsWith("/") || s.endsWith(".")) return null;
  return s;
}
function slugKey(branch) {
  const k = String(branch).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : "w-" + k;
}
function planOpen(records, input) {
  const branch = normalizeBranch(input);
  if (!branch) return { action: "invalid" };
  const slug = slugKey(branch);
  const record = (Array.isArray(records) ? records : []).find((r) => r && r.slug === slug) || null;
  if (record) return { action: "reuse", branch, slug, record };
  return { action: "create", branch, slug };
}
function deriveViewStatus(outcome, msg) {
  switch (outcome.kind) {
    case "loading":
      return { code: "loading", message: msg("Loading\u2026", "\uBD88\uB7EC\uC624\uB294 \uC911\u2026") };
    case "empty":
      return { code: "empty", message: msg("No workspaces", "\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uC5C6\uC74C") };
    case "active":
      return {
        code: "active",
        message: msg(`${outcome.count} workspace(s)`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${outcome.count}\uAC1C`)
      };
    case "error":
      return { code: "error", message: outcome.message };
    default:
      return null;
  }
}

// src/index.js
var GITCORE = "plugin.soksak-plugin-git-core";
var COLL = "workspace";
var SCOPE = "index";
function h(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text !== void 0) el.textContent = text;
  return el;
}
function baseName(p) {
  return String(p ?? "").replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? String(p ?? "");
}
var index_default = {
  activate(ctx) {
    const app = ctx.app;
    const err = (code, message) => ({ ok: false, code, message });
    const msg = (en, ko) => (typeof app.locale === "function" ? app.locale() : "en") === "ko" ? ko : en;
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    void app.data.define(COLL, { indexes: ["slug", "repoRoot", "windowLabel"] });
    const loadRecords = async () => {
      const rows = await app.data.query(COLL, { scope: SCOPE, order: "createdAt" });
      return Array.isArray(rows) ? rows : [];
    };
    const publicRecord = (r) => ({
      slug: r.slug,
      branch: r.branch,
      worktreeDir: r.worktreeDir,
      windowLabel: r.windowLabel,
      repoRoot: r.repoRoot,
      createdAt: r.createdAt
    });
    async function resolveRepoRoot(repoPath) {
      const out = await app.commands.execute(`${GITCORE}.root`, repoPath ? { path: repoPath } : {});
      if (!out.ok) return { ok: false, out };
      if (out.data?.state !== "repo") {
        return { ok: false, out: err("NOT_REPO", msg("not a git repository", "git \uC800\uC7A5\uC18C\uAC00 \uC544\uB2D9\uB2C8\uB2E4")) };
      }
      return { ok: true, root: out.data.root };
    }
    reg("worktree.open", {
      description: "Open a worktree workspace. Given a branch name or issue slug, create the branch and a git worktree (via git-core), then open a project window rooted at the worktree with its default terminal. Idempotent: opening a workspace that already exists focuses its window instead of creating a second one.",
      triggers: { ko: "\uC6CC\uD06C\uD2B8\uB9AC \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uC5F4\uAE30 \uBE0C\uB79C\uCE58 \uC0C8 \uC791\uC5C5 \uC0DD\uC131 \uC6CC\uD06C\uD2B8\uB9AC" },
      params: {
        name: { type: "string", description: "Branch name or issue slug for the workspace", required: true },
        path: { type: "string", description: "Repository directory the worktree branches from (defaults to the active project root)" },
        base: { type: "string", description: "Base ref for the new branch (default HEAD)" }
      },
      returns: "{ slug, branch, worktreeDir, window, created|reused }",
      examples: [
        `sok plugin.soksak-plugin-git-workspace.worktree.open '{"name":"feat/login"}'`,
        `sok plugin.soksak-plugin-git-workspace.worktree.open '{"name":"issue-42","base":"main"}'`
      ],
      message: (d) => d.reused ? msg(`Focused workspace ${d.branch}`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${d.branch} \uD3EC\uCEE4\uC2A4`) : msg(`Opened workspace ${d.branch}`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${d.branch} \uC5F4\uAE30`),
      hint: (d) => d.ok === false ? [] : [{ cmd: "plugin.soksak-plugin-git-workspace.worktree.list", why: msg("see all open workspaces", "\uC5F4\uB9B0 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uC804\uCCB4\uB97C \uBD05\uB2C8\uB2E4") }],
      handler: async (p) => {
        const repoPathParam = typeof p.path === "string" && p.path ? p.path : void 0;
        const projectRoot = app.project?.current?.()?.root ?? void 0;
        const repoPath = repoPathParam ?? projectRoot;
        const rr = await resolveRepoRoot(repoPath);
        if (!rr.ok) return rr.out;
        const repoRoot = rr.root;
        const records = await loadRecords();
        const plan = planOpen(records, p.name);
        if (plan.action === "invalid") {
          return err("INVALID_NAME", msg("name yields no usable branch", "name \uC5D0\uC11C \uC720\uD6A8\uD55C \uBE0C\uB79C\uCE58\uBA85\uC744 \uB9CC\uB4E4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4"));
        }
        if (plan.action === "reuse") {
          const record = plan.record;
          const wo2 = await app.commands.execute("window.open", { root: record.worktreeDir });
          const windowLabel2 = wo2.ok ? wo2.data?.existingWindow || wo2.data?.label || record.windowLabel : record.windowLabel;
          if (windowLabel2 && windowLabel2 !== record.windowLabel) {
            await app.data.put(COLL, { ...record, windowLabel: windowLabel2 }, { scope: SCOPE, id: record.slug });
          }
          app.activity.publish("workspace.open", {
            message: msg(`Focused workspace ${record.branch}`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${record.branch} \uD3EC\uCEE4\uC2A4`),
            slug: record.slug,
            branch: record.branch
          });
          return { reused: true, slug: record.slug, branch: record.branch, worktreeDir: record.worktreeDir, window: windowLabel2 };
        }
        const add = await app.commands.execute(`${GITCORE}.worktree.add`, {
          path: repoRoot,
          branch: plan.branch,
          ...typeof p.base === "string" && p.base ? { base: p.base } : {}
        });
        if (!add.ok) return err(add.code, add.message);
        const dir = add.data.dir;
        const wo = await app.commands.execute("window.open", { root: dir });
        if (!wo.ok) return err(wo.code, wo.message);
        const windowLabel = wo.data?.label || wo.data?.existingWindow || null;
        const rec = {
          slug: plan.slug,
          branch: add.data.branch ?? plan.branch,
          base: add.data.base ?? null,
          repoRoot,
          worktreeDir: dir,
          windowLabel,
          createdAt: Date.now()
        };
        await app.data.put(COLL, rec, { scope: SCOPE, id: plan.slug });
        app.activity.publish("workspace.open", {
          message: msg(`Opened workspace ${rec.branch}`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${rec.branch} \uC5F4\uAE30`),
          slug: rec.slug,
          branch: rec.branch
        });
        return { created: true, slug: rec.slug, branch: rec.branch, worktreeDir: dir, window: windowLabel };
      }
    });
    reg("worktree.close", {
      description: "Close a worktree workspace: close its window and remove the worktree checkout via git-core. The branch and its commits are not touched. Idempotent \u2014 an absent workspace is a no-op. Refuses when the worktree has uncommitted changes (git's protection); commit or discard first.",
      triggers: { ko: "\uC6CC\uD06C\uD2B8\uB9AC \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uB2EB\uAE30 \uD68C\uC218 \uC6CC\uD06C\uD2B8\uB9AC \uC81C\uAC70" },
      params: {
        name: { type: "string", description: "The same branch name or slug used to open the workspace", required: true }
      },
      returns: "{ closed, slug, branch?, worktreeDir? }",
      examples: [
        `sok plugin.soksak-plugin-git-workspace.worktree.close '{"name":"feat/login"}'`
      ],
      message: (d) => d.closed ? msg(`Closed workspace ${d.branch ?? d.slug}`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${d.branch ?? d.slug} \uB2EB\uAE30`) : msg(`No such workspace ${d.slug}`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${d.slug} \uC5C6\uC74C`),
      handler: async (p) => {
        const raw = typeof p.name === "string" ? p.name : "";
        const slug = slugKey(normalizeBranch(raw) || raw);
        const records = await loadRecords();
        const record = records.find((r) => r.slug === slug);
        if (!record) return { closed: false, slug };
        await app.commands.execute("window.close", { label: record.windowLabel });
        const rm = await app.commands.execute(`${GITCORE}.worktree.remove`, {
          path: record.repoRoot,
          dir: record.worktreeDir
        });
        if (!rm.ok) {
          const wl = await app.commands.execute(`${GITCORE}.worktree.list`, { path: record.repoRoot });
          const stillThere = wl.ok && (wl.data?.worktrees ?? []).some((w) => w.path === record.worktreeDir);
          if (stillThere) return err(rm.code, rm.message);
        }
        await app.data.delete(COLL, slug, { scope: SCOPE });
        app.activity.publish("workspace.close", {
          message: msg(`Closed workspace ${record.branch}`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${record.branch} \uB2EB\uAE30`),
          slug,
          branch: record.branch
        });
        return { closed: true, slug, branch: record.branch, worktreeDir: record.worktreeDir };
      }
    });
    reg("worktree.list", {
      description: "List active worktree workspaces \u2014 the same records the Workspaces view shows: slug, branch, worktree directory, hosting window, and origin repository.",
      triggers: { ko: "\uC6CC\uD06C\uD2B8\uB9AC \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uBAA9\uB85D \uC870\uD68C \uC0C1\uD0DC" },
      params: {},
      returns: "{ workspaces: [{slug, branch, worktreeDir, windowLabel, repoRoot, createdAt}] }",
      examples: ["sok plugin.soksak-plugin-git-workspace.worktree.list"],
      message: (d) => msg(`${(d.workspaces ?? []).length} workspace(s)`, `\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 ${(d.workspaces ?? []).length}\uAC1C`),
      handler: async () => ({ workspaces: (await loadRecords()).map(publicRecord) })
    });
    const cleanups = /* @__PURE__ */ new Map();
    ctx.subscriptions.push(
      app.ui.registerView("view", {
        mount(container, vctx) {
          const report = (outcome) => vctx.setStatus?.(deriveViewStatus(outcome, msg));
          container.replaceChildren();
          const wrap = h(
            "div",
            "display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--fg);background:var(--bg)"
          );
          const bar = h(
            "div",
            "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 10px;border-bottom:1px solid var(--bd);flex:0 0 auto;min-height:28px;box-sizing:border-box"
          );
          const title = h("span", "color:var(--fg2)", msg("Workspaces", "\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4"));
          const refreshBtn = h(
            "button",
            "display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;padding:0;cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px"
          );
          refreshBtn.textContent = "\u27F3";
          refreshBtn.title = msg("Refresh", "\uC0C8\uB85C\uACE0\uCE68");
          refreshBtn.dataset.node = "refresh";
          bar.append(title, refreshBtn);
          const errEl = h(
            "div",
            "display:none;padding:8px 10px;color:var(--danger);font-size:11px;white-space:pre-wrap;word-break:break-all;flex:0 0 auto"
          );
          const listEl = h("div", "flex:1 1 auto;min-height:0;overflow:auto;padding:5px 0");
          wrap.append(bar, errEl, listEl);
          container.append(wrap);
          const showError = (text) => {
            errEl.textContent = String(text);
            errEl.style.display = "block";
            report({ kind: "error", message: String(text) });
          };
          async function render() {
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
              listEl.append(h("div", "padding:6px 12px;color:var(--fg3)", msg("No workspaces", "\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uC5C6\uC74C")));
              report({ kind: "empty" });
              return;
            }
            report({ kind: "active", count: records.length });
            const frag = document.createDocumentFragment();
            for (const r of records) {
              const row = h(
                "div",
                "display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer"
              );
              row.title = `${r.branch}  \xB7  ${r.worktreeDir}`;
              row.dataset.node = `row/${r.slug}`;
              const branchEl = h("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)", r.branch);
              const repoEl = h("span", "flex:0 0 auto;color:var(--fg3);font-size:11px", baseName(r.repoRoot));
              const closeBtn = h(
                "button",
                "flex:0 0 auto;width:18px;height:18px;padding:0;cursor:pointer;border:1px solid var(--bd);background:transparent;color:var(--fg3);border-radius:4px;line-height:1"
              );
              closeBtn.textContent = "\xD7";
              closeBtn.title = msg("Close workspace", "\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uB2EB\uAE30");
              closeBtn.dataset.node = `close/${r.slug}`;
              closeBtn.onclick = (ev) => {
                ev.stopPropagation();
                void app.commands.execute("plugin.soksak-plugin-git-workspace.worktree.close", { name: r.slug });
              };
              row.onclick = () => {
                if (r.windowLabel) void app.commands.execute("window.focus", { label: r.windowLabel });
              };
              row.append(branchEl, repoEl, closeBtn);
              frag.append(row);
            }
            listEl.append(frag);
          }
          refreshBtn.onclick = () => void render();
          void render();
          const sub = app.data.watch(COLL, { scope: SCOPE }, () => void render());
          cleanups.set(container, () => sub.dispose());
        },
        unmount(container) {
          cleanups.get(container)?.();
          cleanups.delete(container);
          container.replaceChildren();
        }
      })
    );
  },
  deactivate() {
  }
};
export {
  index_default as default
};
