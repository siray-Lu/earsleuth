/* 好友聊天的端對端測試，打正式的 Worker。
   建出來的臨時帳號最後一定刪掉（克耳朵不會被碰到）。 */
import { readFile } from "node:fs/promises";

const API = "https://earsleuth-api.siray.workers.dev";
const post = (p, b) =>
  fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })
    .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

const 克 = JSON.parse(await readFile(process.env.TEMP + "/claude-acc.json", "utf8"));
const 建出來的 = [];
let 通過 = 0, 失敗 = 0;
const 驗 = (t, c, 附) => {
  if (c === true) { 通過++; console.log("  ✔ " + t + (附 ? "  （" + 附 + "）" : "")); }
  else { 失敗++; console.log("  ✘ " + t + (附 ? "  （" + 附 + "）" : "")); }
};

async function 建帳號(nick, avatar) {
  const r = await post("/api/profile/create", { nick, avatar: avatar || { emoji: "🐸", color: "#4ade80" } });
  if (!r.ok) return r;
  const acc = { id: r.profile.id, token: r.token, recoveryCode: r.recoveryCode, nick: r.profile.nick };
  建出來的.push(acc);
  return { ok: true, acc };
}

try {
  console.log("① 準備：建一個臨時帳號並跟克耳朵成為好友");
  const 甲 = await 建帳號("聊天測試員");
  if (!甲.ok) { console.log("  ✘ 建不出帳號：" + JSON.stringify(甲)); throw new Error("stop"); }
  驗("建立「聊天測試員」", true, 甲.acc.id);
  await post("/api/friends/request", { playerId: 甲.acc.id, token: 甲.acc.token, targetId: 克.id });
  const 成為好友 = await post("/api/friends/respond", { playerId: 克.id, token: 克.token, fromId: 甲.acc.id, accept: true });
  驗("兩邊成為好友", 成為好友.ok === true && 成為好友.accepted === true);

  console.log("② 送訊息與收訊息");
  const s1 = await post("/api/chat/send", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: 克.id, text: "哈囉，測試一下" });
  驗("甲送出第一則", s1.ok === true && s1.msg && s1.msg.seq === 1, s1.msg ? "seq=" + s1.msg.seq : JSON.stringify(s1));
  const s2 = await post("/api/chat/send", { playerId: 克.id, token: 克.token, friendId: 甲.acc.id, text: "收到了" });
  驗("克耳朵回一則，序號接續", s2.ok === true && s2.msg && s2.msg.seq === 2, s2.msg ? "seq=" + s2.msg.seq : "");

  const 克讀 = await post("/api/chat/list", { playerId: 克.id, token: 克.token, friendId: 甲.acc.id });
  驗("克耳朵讀得到兩則", 克讀.ok === true && (克讀.msgs || []).length === 2);
  驗("兩邊進到同一間聊天室", (克讀.msgs || []).map((m) => m.text).join("｜") === "哈囉，測試一下｜收到了",
    (克讀.msgs || []).map((m) => m.text).join("｜"));
  const 甲讀 = await post("/api/chat/list", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: 克.id });
  驗("甲讀到的內容一樣", JSON.stringify((甲讀.msgs || []).map((m) => m.text)) === JSON.stringify((克讀.msgs || []).map((m) => m.text)));

  console.log("③ 只拿新的（輪詢用）");
  const 增量 = await post("/api/chat/list", { playerId: 克.id, token: 克.token, friendId: 甲.acc.id, since: 1 });
  驗("帶 since=1 只回第 2 則", (增量.msgs || []).length === 1 && 增量.msgs[0].seq === 2);
  const 沒新的 = await post("/api/chat/list", { playerId: 克.id, token: 克.token, friendId: 甲.acc.id, since: 2 });
  驗("沒有新的就回空陣列", (沒新的.msgs || []).length === 0 && 沒新的.seq === 2);

  console.log("④ 未讀數");
  const 甲清單 = await post("/api/friends/list", { playerId: 甲.acc.id, token: 甲.acc.token });
  驗("甲有 1 則未讀（克耳朵回的那則）", (甲清單.unread || {})[克.id] === 1, JSON.stringify(甲清單.unread));
  const 克清單 = await post("/api/friends/list", { playerId: 克.id, token: 克.token });
  驗("克耳朵有 1 則未讀（甲送的那則）", (克清單.unread || {})[甲.acc.id] === 1, JSON.stringify(克清單.unread));
  await post("/api/chat/mark-read", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: 克.id });
  const 甲清單2 = await post("/api/friends/list", { playerId: 甲.acc.id, token: 甲.acc.token });
  驗("甲標為已讀後歸零", (甲清單2.unread || {})[克.id] == null, JSON.stringify(甲清單2.unread));
  驗("不會順便把對方的未讀也清掉", (await post("/api/friends/list", { playerId: 克.id, token: 克.token })).unread[甲.acc.id] === 1);

  console.log("⑤ 擋不該過的");
  const 空的 = await post("/api/chat/send", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: 克.id, text: "   " });
  驗("空白訊息送不出去", 空的.ok === false && 空的.error === "empty");
  const 壞token = await post("/api/chat/send", { playerId: 甲.acc.id, token: "亂打的", friendId: 克.id, text: "嗨" });
  驗("token 不對送不出去", 壞token.ok === false && 壞token.status === 403);
  const 陌生人 = await post("/api/chat/send", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: "61c40342db7c", text: "嗨" });
  驗("不是好友送不出去", 陌生人.ok === false && 陌生人.error === "not friends", 陌生人.error);
  const 超長 = await post("/api/chat/send", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: 克.id, text: "字".repeat(500) });
  驗("超長訊息被截到 200 字", 超長.ok === true && 超長.msg.text.length === 200, 超長.ok ? 超長.msg.text.length + " 字" : "");

  console.log("⑥ 刪好友會把聊天紀錄一起清掉");
  await post("/api/friends/remove", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: 克.id });
  const 刪後 = await post("/api/chat/list", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: 克.id });
  驗("聊天紀錄清空", (刪後.msgs || []).length === 0 && 刪後.seq === 0);
  const 克刪後 = await post("/api/friends/list", { playerId: 克.id, token: 克.token });
  驗("克耳朵那邊的好友也拿掉了", !(克刪後.friends || []).some((f) => f.id === 甲.acc.id));
  驗("克耳朵那邊的未讀也歸零", (克刪後.unread || {})[甲.acc.id] == null, JSON.stringify(克刪後.unread));
} catch (e) {
  if (String(e.message) !== "stop") { 失敗++; console.log("  ✘ 測試中途炸了：" + (e && e.stack || e)); }
} finally {
  console.log("");
  console.log("清掉測試帳號：");
  for (const a of 建出來的) {
    const d = await post("/api/profile/delete", { playerId: a.id, token: a.token, recoveryCode: a.recoveryCode });
    console.log("  " + (d.ok ? "✔" : "✘") + " " + a.nick + " (" + a.id + ")" + (d.ok ? "" : "  " + JSON.stringify(d)));
  }
  console.log("");
  console.log("通過 " + 通過 + " 項，失敗 " + 失敗 + " 項");
  process.exitCode = 失敗 ? 1 : 0;
}
