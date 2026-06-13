// 进展看板数据层测试（Node 环境，无 localStorage → 内存降级）
import { Board, buildItems, composeAgentSummary } from "./js/board.js";

// ---- buildItems：确定性提炼 ----
let items = buildItems({
  policies: ["全员降本"],
  bugsFixed: 2,
  collabs: [{ visitor: "老妖", host: "龙哥", bugFixed: false }],
  breaking: ["百度网盘限速上热搜"],
  market: ["夸克高考活动"]
});
const types = items.map(i => i.type);
if (!types.includes("决策")) throw new Error("政策应生成决策条目");
if (!types.includes("进展")) throw new Error("修 bug/协作应生成进展条目");
if (!types.includes("应对")) throw new Error("市场/突发应生成应对条目");
if (!items.some(i => i.text.includes("2 个 Bug"))) throw new Error("应汇总修复 bug 数");
console.log("buildItems:", items.length, "条:", items.map(i => `[${i.type}]`).join(""));

// 空记录
if (buildItems({}).length !== 0) throw new Error("空记录应无条目");

// ---- composeAgentSummary ----
const mem = [
  { c: "参加了每日站会", type: "event", day: 1 },
  { c: "和 龙哥 一起修复了一个产品 Bug", type: "event", day: 1 },
  { c: "我主动去找 龙哥 讨论工作", type: "event", day: 1 },
  { c: "今日反思：明天先把带宽成本压下来", type: "reflect", day: 1 }
];
const summary = composeAgentSummary(mem);
if (!summary.includes("会")) throw new Error("应统计会议");
if (!summary.includes("Bug")) throw new Error("应统计修复");
if (!summary.includes("感悟")) throw new Error("应带上反思");
console.log("个人小结:", summary);
if (composeAgentSummary([]) !== "日常工作，无特别记录") throw new Error("空记忆应有兜底文案");

// ---- Board 存取（内存降级）----
const b = new Board();
let updated = 0;
b.onUpdate = () => updated++;
b.recordDay(1, items, { laoyao: "开了2个会" });
b.recordDay(2, [{ type: "进展", text: "上线了缩略图优化" }], { wudi: "重构组件库" });
if (updated !== 2) throw new Error("recordDay 应触发 onUpdate");
if (b.recent().length !== 2) throw new Error("应有两天记录");
if (b.recent()[0].day !== 2) throw new Error("最新天应在前");
if (b.summaryFor("laoyao").text !== "开了2个会") throw new Error("个人小结查询失败");
if (b.summaryFor("nobody") !== null) throw new Error("无记录应返回 null");

// 覆盖同一天
b.recordDay(2, [{ type: "决策", text: "改版定了" }], {});
if (b.days.filter(d => d.day === 2).length !== 1) throw new Error("同一天应被覆盖而非重复");

// 非法 type 过滤
b.recordDay(3, [{ type: "瞎写", text: "x" }, { type: "进展", text: "ok" }], {});
if (b.recent()[0].items.length !== 1) throw new Error("非法 type 应被过滤");

console.log("ALL BOARD TESTS PASSED");
