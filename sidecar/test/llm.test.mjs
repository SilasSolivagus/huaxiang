import { test } from "node:test";
import assert from "node:assert/strict";
import { SidecarLLM } from "../src/llm.js";

function anthropicResponse(text) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" })
  };
}

test("未配置 key 时 enabled=false，scoreBatch 返回 null", async () => {
  const llm = new SidecarLLM({}, async () => { throw new Error("不该发起请求"); });
  assert.equal(llm.enabled, false);
  assert.equal(await llm.scoreBatch([{ title: "x" }], "公司"), null);
});

test("scoreBatch 解析 JSON 数组并按 i 对位，容忍 markdown 代码栏", async () => {
  const reply = '```json\n[{"i":0,"relevance":8,"summary":"竞品涨价","suggestedImpact":{"dau":"+2%"}},{"i":1,"relevance":2,"summary":"无关"}]\n```';
  const llm = new SidecarLLM(
    { SIDECAR_API_KEY: "k", SIDECAR_MODEL: "m" },
    async () => anthropicResponse(reply)
  );
  const out = await llm.scoreBatch(
    [{ title: "竞品宣布涨价", snippet: "" }, { title: "某地天气", snippet: "" }],
    "123云盘"
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].relevance, 8);
  assert.equal(out[0].summary, "竞品涨价");
  assert.deepEqual(out[0].suggestedImpact, { dau: "+2%" });
  assert.equal(out[1].relevance, 2);
});

test("模型返回非法 JSON 时 scoreBatch 返回 null 而不是抛错", async () => {
  const llm = new SidecarLLM(
    { SIDECAR_API_KEY: "k", SIDECAR_MODEL: "m" },
    async () => anthropicResponse("抱歉我无法……")
  );
  assert.equal(await llm.scoreBatch([{ title: "x" }], "公司"), null);
});

test("openai 兼容模式走 chat/completions 接口", async () => {
  let calledUrl = "";
  const llm = new SidecarLLM(
    { SIDECAR_PROVIDER: "openai", SIDECAR_API_KEY: "k", SIDECAR_MODEL: "deepseek-chat", SIDECAR_BASE_URL: "https://api.deepseek.com/v1" },
    async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"i":0,"relevance":7,"summary":"s"}]' } }] }) };
    }
  );
  const out = await llm.scoreBatch([{ title: "x" }], "公司");
  assert.equal(calledUrl, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(out[0].relevance, 7);
});
