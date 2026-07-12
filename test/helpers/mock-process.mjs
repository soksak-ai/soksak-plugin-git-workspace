// Test process capability — records spawns and replays scripted git output. Same interface as
// app.process (spawn/onData/onStderr/onExit/kill). handler(cmd, args, opts) → {stdout, stderr, code}.
// onExit fires after onData/onStderr (two microtasks) so accumulated output is present at resolve.
export function mockProcess(handler) {
  const calls = [];
  const procs = new Map();
  let seq = 0;
  const api = {
    async spawn(cmd, args, opts) {
      const id = ++seq;
      calls.push({ cmd, args, opts: opts ?? {} });
      procs.set(id, handler(cmd, args, opts ?? {}) ?? { stdout: "", stderr: "", code: 0 });
      return id;
    },
    onData(id, cb) {
      const r = procs.get(id);
      if (r?.stdout) queueMicrotask(() => cb(new TextEncoder().encode(r.stdout)));
      return { dispose() {} };
    },
    onStderr(id, cb) {
      const r = procs.get(id);
      if (r?.stderr) queueMicrotask(() => cb(new TextEncoder().encode(r.stderr)));
      return { dispose() {} };
    },
    onExit(id, cb) {
      const r = procs.get(id);
      queueMicrotask(() => queueMicrotask(() => cb(r?.code ?? 0)));
      return { dispose() {} };
    },
    async kill(id) {
      procs.delete(id);
    },
  };
  return { api, calls };
}
