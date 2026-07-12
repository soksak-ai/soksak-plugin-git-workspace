// Command-surface conformance — C2 transparency (command axis) + declared ≡ actual (both ways).
// Axes: ① manifest contributes.commands ≡ activate registrations (bidirectional)
//       ② danger declared ≡ registered spec danger (bidirectional)
//       ③ mandatory spec fields (description · ko triggers · examples · message · returns — T1)
//       ④ the declared view is registered
// Runs with node --test (no app — the host is mocked).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockApp } from "./helpers/mock-app.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const plugin = (await import("../main.js")).default;

function activated() {
  const m = mockApp({ manifest });
  plugin.activate(m.ctx);
  return m;
}

test("declared ≡ registered — bidirectional (no missing registration, no ghost declaration)", () => {
  const { registered } = activated();
  const declared = manifest.contributes.commands.map((c) => c.name).sort();
  const actual = [...registered.keys()].sort();
  assert.deepEqual(actual, declared);
});

test("danger declared ≡ registered spec danger — bidirectional", () => {
  const { registered } = activated();
  for (const c of manifest.contributes.commands) {
    const spec = registered.get(c.name);
    assert.equal(spec.danger, c.danger, `${c.name}: manifest=${c.danger} spec=${spec.danger}`);
  }
});

test("T1 mandatory fields — description · ko triggers · examples · message · returns", () => {
  const { registered } = activated();
  for (const [name, spec] of registered) {
    assert.ok(spec.description?.length > 10, `${name}: description`);
    assert.ok(spec.triggers?.ko?.length > 0, `${name}: triggers.ko`);
    assert.ok(Array.isArray(spec.examples) && spec.examples.length >= 1, `${name}: examples`);
    assert.equal(typeof spec.message, "function", `${name}: message`);
    assert.ok(spec.returns?.length > 0, `${name}: returns`);
  }
});

test("the declared view is registered", () => {
  const { views } = activated();
  const declared = manifest.contributes.views.map((v) => v.id);
  for (const id of declared) assert.ok(views.has(id), `view ${id} not registered`);
});

test("deactivate roundtrip — subscriptions dispose", () => {
  const m = mockApp({ manifest });
  plugin.activate(m.ctx);
  for (const d of m.ctx.subscriptions) d.dispose();
  if (plugin.deactivate) plugin.deactivate();
});
