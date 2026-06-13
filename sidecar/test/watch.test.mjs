import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "../src/collectors/watch.js";

test("extractText 去掉脚本/样式/标签，解码实体，压空白", () => {
  const html = `<html><head><style>.a{color:red}</style><script>var x=1</script></head>
    <body><h1>会员价格</h1><p>SVIP&nbsp;年卡 &amp; 月卡<br>限时 5 折</p></body></html>`;
  const t = extractText(html);
  assert.ok(t.includes("会员价格"));
  assert.ok(t.includes("SVIP 年卡 & 月卡"));
  assert.ok(!t.includes("color:red"));
  assert.ok(!t.includes("var x"));
  assert.ok(!t.includes("<"));
});

test("extractText 空/非字符串安全", () => {
  assert.equal(extractText(""), "");
  assert.equal(extractText(null), "");
  assert.equal(extractText(undefined), "");
});
