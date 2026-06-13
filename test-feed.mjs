// Feed 纯逻辑测试（Node 环境，不依赖浏览器）
import { diffPolicies, Feed } from "./js/feed.js";

// 新政策 → announced
let d = diffPolicies({}, [{ id: "pol_1", text: "降本", active: true }]);
if (d.announced.length !== 1 || d.announced[0].id !== "pol_1") throw new Error("新政策应进 announced");
if (d.revoked.length !== 0) throw new Error("不应有 revoked");

// 已见过且仍 active → 无动作
d = diffPolicies({ pol_1: true }, [{ id: "pol_1", text: "降本", active: true }]);
if (d.announced.length !== 0 || d.revoked.length !== 0) throw new Error("无变化时应静默");

// 之前 active 的政策消失/失效 → revoked
d = diffPolicies({ pol_1: true }, []);
if (d.revoked.length !== 1 || d.revoked[0] !== "pol_1") throw new Error("撤销检测失败");

// 之前就 inactive 的不再重复公告撤销
d = diffPolicies({ pol_1: false }, []);
if (d.revoked.length !== 0) throw new Error("已撤销的不应重复公告");

const f = new Feed();   // 未 connect → online=false
const v = await f.embed(["x"]);
if (v !== null) throw new Error("离线时 embed 应返回 null（触发 bigram 回退）");
console.log("feed.embed 离线回退验证 ✓");

console.log("ALL FEED TESTS PASSED");
