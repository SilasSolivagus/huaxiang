import { parseTurn } from "./js/cognition/converse.js";

// 合法对象
const a = parseTurn({ utterance: "我觉得可以上限速", done: false });
if (a.utterance !== "我觉得可以上限速" || a.done !== false) throw new Error("合法对象解析错");
const b = parseTurn({ utterance: "没什么要补充了", done: true });
if (b.done !== true) throw new Error("done=true 应保留");

// JSON 字符串（围栏）+ 去引号
const c = parseTurn('```json\n{"utterance":"「带宽得盯」","done":true}\n```');
if (c.utterance !== "带宽得盯") throw new Error("应解析围栏并去引号");
if (c.done !== true) throw new Error("done 应为 true");

// 非 JSON → 整段当一句话、done=false、去引号
const d = parseTurn("「就这么定」");
if (d.utterance !== "就这么定" || d.done !== false) throw new Error("非 JSON 应当作一句话、done=false");

// 脏/空输入安全
if (parseTurn(null).utterance !== "" || parseTurn(null).done !== false) throw new Error("null 应安全");
if (parseTurn([1]).utterance !== "") throw new Error("数组应空 utterance");
// done 非布尔 → 强制布尔
if (parseTurn({ utterance: "x", done: "yes" }).done !== true) throw new Error("done 真值应转 true");
if (parseTurn({ utterance: "x" }).done !== false) throw new Error("缺 done 应为 false");

console.log("converse OK");
