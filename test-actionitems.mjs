import { newActionItem, advanceActionItems, ActionItemStore } from "./js/cognition/actionItems.js";

// newActionItem：初始 todo，字段齐全，显式 devDays 被保留
const it = newActionItem({ what: "评估带宽方案", owner: "王强", zone: "rd", day: 3, devDays: 2 });
if (it.status !== "todo") throw new Error("初始应为 todo");
if (it.createdDay !== 3 || it.devDays !== 2 || it.shipDay !== null) throw new Error("字段不对");
if (!it.id) throw new Error("应有 id");
if (it.owner !== "王强" || it.zone !== "rd") throw new Error("owner/zone 不对");

// advanceActionItems：todo→dev（设 shipDay = day + devDays），不立即上线
let items = [newActionItem({ what: "A", day: 1, devDays: 1 })];
let r = advanceActionItems(items, 2);
if (r.items[0].status !== "dev") throw new Error("第2天 todo 应转 dev");
if (r.items[0].shipDay !== 3) throw new Error("shipDay 应为 2+1=3");
if (r.shipped.length !== 0) throw new Error("刚进 dev 不应同日上线");

// dev → shipped（day >= shipDay）
r = advanceActionItems(r.items, 3);
if (r.items[0].status !== "shipped") throw new Error("第3天应上线");
if (r.items[0].shippedDay !== 3) throw new Error("shippedDay 应记 3");
if (r.shipped.length !== 1 || r.shipped[0].what !== "A") throw new Error("应返回当日上线项");

// 已上线项再 advance 不变、不重复计入 shipped
r = advanceActionItems(r.items, 4);
if (r.shipped.length !== 0) throw new Error("已上线不应重复上线");

// 入参不被修改；非数组安全
const src = [newActionItem({ what: "B", day: 1, devDays: 1 })];
advanceActionItems(src, 2);
if (src[0].status !== "todo") throw new Error("不应修改入参");
if (advanceActionItems(null, 1).items.length !== 0) throw new Error("null 应安全");

// ActionItemStore：add / advance / byStatus / openFor（node 无 localStorage 也能用内存态）
const store = new ActionItemStore();
store.items = [];   // node 下从空开始（无 localStorage）
store.add(newActionItem({ what: "改限速", owner: "何再东", day: 1, devDays: 1 }));
if (store.byStatus("todo").length !== 1) throw new Error("应有 1 条 todo");
const shipped2 = store.advance(2);   // todo→dev
if (shipped2.length !== 0) throw new Error("第2天还不上线");
const shipped3 = store.advance(3);   // dev→shipped
if (shipped3.length !== 1) throw new Error("第3天上线 1 条");
if (store.openFor("何再东").length !== 0) throw new Error("上线后 openFor 应为空");

console.log("actionItems OK");
