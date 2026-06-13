import {
  parseBoard, parseMemories, groupActivityByDay, groupMinutesByDay,
  collectPersonSummaries, sortMemoriesDesc
} from "./js/records.js";
import { escapeHtml, renderBoardDay, renderMinuteCard, renderMemoryItem } from "./js/records.js";

// parseBoard：合法数组 / 脏输入降级
if (parseBoard('[{"day":1,"items":[],"summaries":{}}]').length !== 1) throw new Error("parseBoard 合法数组");
if (parseBoard("not json").length !== 0) throw new Error("parseBoard 脏输入应空");
if (parseBoard(null).length !== 0) throw new Error("parseBoard null 应空");
if (parseBoard('{"a":1}').length !== 0) throw new Error("parseBoard 非数组应空");

// parseMemories：对象 / 脏输入降级
const mem = parseMemories('{"wang":[{"c":"x","day":1}]}');
if (!mem.wang || mem.wang.length !== 1) throw new Error("parseMemories 对象");
if (Object.keys(parseMemories("[]")).length !== 0) throw new Error("parseMemories 数组应空对象");
if (Object.keys(parseMemories("bad")).length !== 0) throw new Error("parseMemories 脏输入应空对象");

// groupActivityByDay：按天倒序、天内保序
const g = groupActivityByDay([
  { day: 1, time: "09:00", text: "a" }, { day: 2, time: "10:00", text: "b" },
  { day: 1, time: "11:00", text: "c" }
]);
if (g[0].day !== 2 || g[1].day !== 1) throw new Error("应按天倒序");
if (g[1].entries.length !== 2 || g[1].entries[0].text !== "a") throw new Error("天内应保序");
if (groupActivityByDay(null).length !== 0) throw new Error("null → []");

// groupMinutesByDay：按 day 倒序分组
const gm = groupMinutesByDay([{ day: 1, content: "x" }, { day: 3, content: "y" }, { day: 1, content: "z" }]);
if (gm[0].day !== 3 || gm[1].day !== 1 || gm[1].items.length !== 2) throw new Error("纪要应按天倒序分组");

// collectPersonSummaries：收集某人各天小结，天倒序
const days = [
  { day: 1, summaries: { wang: "第一天", li: "x" } },
  { day: 2, summaries: { wang: "第二天" } },
  { day: 3, summaries: {} }
];
const ws = collectPersonSummaries(days, "wang");
if (ws.length !== 2 || ws[0].day !== 2) throw new Error("应收集 wang 两天且天倒序");

// sortMemoriesDesc：按 t 倒序，不改入参
const items = [{ c: "a", t: 10 }, { c: "b", t: 30 }, { c: "c", t: 20 }];
const sorted = sortMemoriesDesc(items);
if (sorted[0].c !== "b" || sorted[2].c !== "a") throw new Error("应按 t 倒序");
if (items[0].c !== "a") throw new Error("不应修改入参");

// escapeHtml
if (escapeHtml('<a>&"') !== "&lt;a&gt;&amp;&quot;") throw new Error("escapeHtml 转义不对");

// renderBoardDay：含天号、标签 class、小结人名映射、转义
const bd = renderBoardDay(
  { day: 5, items: [{ type: "进展", text: "上线<限速>" }], summaries: { wang: "干了活" } },
  { wang: "王强" }
);
if (!bd.includes("第 5 天")) throw new Error("应含天号");
if (!bd.includes("bi-progress")) throw new Error("进展应映射 bi-progress");
if (!bd.includes("上线&lt;限速&gt;")) throw new Error("正文应转义");
if (!bd.includes("王强") || !bd.includes("干了活")) throw new Error("小结应用人名映射");

// renderMinuteCard：用 meta 三段，行动项含 owner
const mc = renderMinuteCard({
  day: 4, content: "兜底正文",
  meta: { zone: "rd", phase: "每日站会", decisions: ["上线限速"], risks: ["带宽成本"], actionItems: [{ owner: "王强", what: "评估方案" }] }
});
if (!mc.includes("第 4 天") || !mc.includes("rd") || !mc.includes("每日站会")) throw new Error("应含头部信息");
if (!mc.includes("上线限速") || !mc.includes("带宽成本") || !mc.includes("评估方案")) throw new Error("三段都应渲染");
if (!mc.includes("王强")) throw new Error("行动项应含 owner");

// renderMinuteCard：无 meta 段时回退 content
const mc2 = renderMinuteCard({ day: 1, content: "只有正文", meta: { zone: "ops", phase: "评审会" } });
if (!mc2.includes("只有正文")) throw new Error("无三段应回退 content");

// renderMemoryItem：反思/行动项加 class，转义
const r = renderMemoryItem({ c: "今日反思：累了", type: "reflect", day: 2, time: "18:00" });
if (!r.includes("rc-mem-reflect")) throw new Error("反思应加 reflect class");
const ac = renderMemoryItem({ c: "行动项：改bug", type: "action", day: 2, time: "10:00" });
if (!ac.includes("rc-mem-action")) throw new Error("行动项应加 action class");

console.log("records parse/group OK");
