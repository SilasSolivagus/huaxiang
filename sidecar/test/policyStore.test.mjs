import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { PolicyStore } from "../src/policyStore.js";

test("create / list / deactivate 完整生命周期", () => {
  const s = new PolicyStore(openDb(":memory:"));
  const p = s.create("本季度冻结新功能，全员优先降本");
  assert.match(p.id, /^pol_/);
  assert.equal(p.active, true);

  assert.equal(s.list().length, 1);            // 默认只列 active
  assert.equal(s.deactivate(p.id), true);
  assert.equal(s.list().length, 0);
  assert.equal(s.list(true).length, 1);        // all=true 含已撤销
  assert.equal(s.list(true)[0].active, false);
  assert.equal(s.deactivate(p.id), false);     // 重复撤销返回 false
});

test("空文本拒绝创建", () => {
  const s = new PolicyStore(openDb(":memory:"));
  assert.throws(() => s.create("   "));
});
