// Test host app — runs activate() without the real app (a subset of the api, same shape).
// commands.execute is stubbed (optionally scripted via opts.executeCommand); data is an
// in-memory store; ui.registerView records the provider; activity/events are recorded.
export function mockApp(opts = {}) {
  const registered = new Map();
  const views = new Map();
  const activity = [];
  const executed = [];
  const store = new Map(); // `${coll}\0${scope}\0${id}` → doc

  const key = (coll, scope, id) => `${coll}\0${scope ?? "default"}\0${id}`;

  const app = {
    appVersion: "test",
    pluginId: "soksak-plugin-git-workspace",
    locale: () => opts.locale ?? "en",
    windowLabel: () => opts.windowLabel ?? "w-test",
    project: { current: () => opts.project ?? null },
    commands: {
      register(name, spec) {
        registered.set(name, spec);
        return { dispose() {} };
      },
      async execute(name, params) {
        executed.push({ name, params });
        if (opts.executeCommand) return opts.executeCommand(name, params);
        return { ok: true, code: "OK", message: "", data: {} };
      },
    },
    events: { on: () => ({ dispose() {} }), progress: () => {} },
    activity: { publish: (kind, entry) => activity.push({ kind, entry }) },
    data: {
      async define() {},
      async put(coll, doc, o) {
        const id = o?.id ?? doc.id ?? String(store.size + 1);
        store.set(key(coll, o?.scope, id), { ...doc, id });
        return id;
      },
      async get(coll, id, o) {
        return store.get(key(coll, o?.scope, id)) ?? null;
      },
      async delete(coll, id, o) {
        return store.delete(key(coll, o?.scope, id));
      },
      async query(coll, o) {
        const prefix = `${coll}\0${o?.scope ?? "default"}\0`;
        const rows = [];
        for (const [k, v] of store) if (k.startsWith(prefix)) rows.push(v);
        rows.sort((a, b) => (a[o?.order ?? "createdAt"] ?? 0) - (b[o?.order ?? "createdAt"] ?? 0));
        return rows;
      },
      watch: () => ({ dispose() {} }),
    },
    ui: {
      registerView(viewId, provider) {
        views.set(viewId, provider);
        return { dispose() {} };
      },
    },
  };

  const ctx = { app, manifest: opts.manifest ?? {}, subscriptions: [] };
  return { app, ctx, registered, views, activity, executed, store };
}
