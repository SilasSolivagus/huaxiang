import { appendCapped, addActivity, loadActivity } from "./js/activityLog.js";

// appendCapped：追加保序
let l = [];
l = appendCapped(l, { text: "a" });
l = appendCapped(l, { text: "b" });
if (l.length !== 2 || l[0].text !== "a" || l[1].text !== "b") throw new Error("append 应保序");

// appendCapped：超 max 丢最旧
let big = [];
for (let i = 0; i < 5; i++) big = appendCapped(big, { text: "n" + i }, 3);
if (big.length !== 3 || big[0].text !== "n2" || big[2].text !== "n4") throw new Error("超 max 应丢最旧、留最后 3 条");

// appendCapped：非数组输入从空开始，不改原数组
const src = [{ text: "x" }];
const out = appendCapped(src, { text: "y" }, 10);
if (src.length !== 1) throw new Error("不应修改入参数组");
if (appendCapped(null, { text: "z" }).length !== 1) throw new Error("null 入参应从空开始");

// 无 localStorage（node）：addActivity 安全 no-op、loadActivity 返回 []
addActivity({ text: "不应抛错", day: 1, time: "09:00" });
if (loadActivity().length !== 0) throw new Error("无 storage 时 loadActivity 应为 []");

console.log("activityLog OK");
