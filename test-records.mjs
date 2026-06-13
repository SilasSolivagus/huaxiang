import {
  parseBoard, parseMemories, groupActivityByDay, groupMinutesByDay,
  collectPersonSummaries, sortMemoriesDesc
} from "./js/records.js";

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

console.log("records parse/group OK");
