/* 好友第一階段的端對端測試，打的是正式的 Worker。

   建出來的測試帳號一律在最後刪掉（克耳朵不在這裡面，不會被碰到）。
   重點：/api/profile/create 會無視送進去的 playerId 自己產一個，
   所以建完第一件事就是把伺服器給的 id / token / 接回碼記下來，
   不然刪不掉 —— 上次就這樣留下一個孤兒帳號。 */
const API = "https://earsleuth-api.siray.workers.dev";
const post = (p, b) =>
  fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) })
    .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

const 建出來的 = [];
// 同一個 IP 一小時只能建 20 份檔案。測太多次撞到額度時，那幾項不是失敗，
// 是根本沒跑到 —— 分開記，不然會以為功能壞了。
let 跳過 = 0;
function 額度用完(r){ return r && (r.status === 429 || r.error === "too many profiles"); }
let 通過 = 0, 失敗 = 0;

function 略(標題){ 跳過++; console.log("  — " + 標題 + "  （建檔額度用完，這項沒跑到）"); }
function 驗(標題, 條件, 附註) {
  if (condTrue(條件)) { 通過++; console.log("  ✔ " + 標題 + (附註 ? "  （" + 附註 + "）" : "")); }
  else { 失敗++; console.log("  ✘ " + 標題 + (附註 ? "  （" + 附註 + "）" : "")); }
}
const condTrue = (c) => c === true;

async function 建帳號(nick, avatar) {
  const r = await post("/api/profile/create", { nick, avatar: avatar || { emoji: "🎤", color: "#ff5fa2" } });
  if (!r.ok) return r;
  const acc = { id: r.profile.id, token: r.token, recoveryCode: r.recoveryCode, nick: r.profile.nick };
  建出來的.push(acc);
  return { ok: true, acc, raw: r };
}

try {
  console.log("① 名字唯一");
  const 甲 = await 建帳號("測試甲");
  驗("建立「測試甲」", 甲.ok === true, 甲.ok ? 甲.acc.id : JSON.stringify(甲));
  const 撞名 = await post("/api/profile/create", { nick: "測試甲", avatar: { emoji: "🎸", color: "#5fd0ff" } });
  驗("同名再建一個會被擋下", 撞名.ok === false && 撞名.error === "nick taken", "回應 " + 撞名.status + " " + 撞名.error);
  const 全形 = await post("/api/profile/create", { nick: "測試甲 ", avatar: { emoji: "🎸", color: "#5fd0ff" } });
  驗("前後空白不算另一個名字", 全形.ok === false && 全形.error === "nick taken");
  const 乙 = await 建帳號("測試乙", { emoji: "🦊", color: "#4ade80" });
  驗("建立「測試乙」", 乙.ok === true);

  console.log("② 用名字找人");
  const 找乙 = await post("/api/friends/search", { playerId: 甲.acc.id, token: 甲.acc.token, nick: "測試乙" });
  驗("甲搜尋「測試乙」找得到", 找乙.ok === true && !!找乙.found && 找乙.found.id === 乙.acc.id,
    找乙.found ? 找乙.found.avatar.emoji + " " + 找乙.found.nick : "沒找到");
  驗("搜尋結果帶著戰績", !!(找乙.found && 找乙.found.stats && typeof 找乙.found.stats.games === "number"));
  驗("搜尋結果沒有外洩 token", !!找乙.found && !("token" in 找乙.found) && !("recoveryCode" in 找乙.found));
  const 找不到 = await post("/api/friends/search", { playerId: 甲.acc.id, token: 甲.acc.token, nick: "這個名字沒有人用" });
  驗("查無此人回 null 而不是報錯", 找不到.ok === true && 找不到.found === null);
  const 沒token = await post("/api/friends/search", { playerId: 甲.acc.id, token: "亂打的", nick: "測試乙" });
  驗("沒有正確 token 不能搜尋", 沒token.ok === false && 沒token.status === 403);

  console.log("③ 送邀請與接受");
  const 送 = await post("/api/friends/request", { playerId: 甲.acc.id, token: 甲.acc.token, targetId: 乙.acc.id });
  驗("甲送邀請給乙", 送.ok === true);
  const 乙的 = await post("/api/friends/list", { playerId: 乙.acc.id, token: 乙.acc.token });
  驗("乙的收件匣收到了", (乙的.incoming || []).some((f) => f.id === 甲.acc.id));
  const 甲的 = await post("/api/friends/list", { playerId: 甲.acc.id, token: 甲.acc.token });
  驗("甲的寄件匣記著", (甲的.outgoing || []).some((f) => f.id === 乙.acc.id));
  const 重送 = await post("/api/friends/request", { playerId: 甲.acc.id, token: 甲.acc.token, targetId: 乙.acc.id });
  驗("重複送不會變成錯誤", 重送.ok === true);
  const 自己 = await post("/api/friends/request", { playerId: 甲.acc.id, token: 甲.acc.token, targetId: 甲.acc.id });
  驗("不能加自己", 自己.ok === false && 自己.error === "self");

  const 接受 = await post("/api/friends/respond", { playerId: 乙.acc.id, token: 乙.acc.token, fromId: 甲.acc.id, accept: true });
  驗("乙按接受", 接受.ok === true && 接受.accepted === true);
  const 乙的2 = await post("/api/friends/list", { playerId: 乙.acc.id, token: 乙.acc.token });
  const 甲的2 = await post("/api/friends/list", { playerId: 甲.acc.id, token: 甲.acc.token });
  驗("乙的好友清單有甲", (乙的2.friends || []).some((f) => f.id === 甲.acc.id));
  驗("甲的好友清單有乙", (甲的2.friends || []).some((f) => f.id === 乙.acc.id));
  驗("乙的收件匣清空了", (乙的2.incoming || []).length === 0);
  驗("甲的寄件匣清空了", (甲的2.outgoing || []).length === 0);

  console.log("④ 互相送 = 直接成為好友");
  const 丙 = await 建帳號("測試丙", { emoji: "🐧", color: "#a78bfa" });
  驗("建立「測試丙」", 丙.ok === true);
  await post("/api/friends/request", { playerId: 丙.acc.id, token: 丙.acc.token, targetId: 甲.acc.id });
  const 回送 = await post("/api/friends/request", { playerId: 甲.acc.id, token: 甲.acc.token, targetId: 丙.acc.id });
  驗("甲也送給丙時直接成立", 回送.ok === true && 回送.becameFriends === true);
  const 丙的 = await post("/api/friends/list", { playerId: 丙.acc.id, token: 丙.acc.token });
  驗("丙的好友清單有甲", (丙的.friends || []).some((f) => f.id === 甲.acc.id));
  驗("丙的寄件匣清空了", (丙的.outgoing || []).length === 0);

  console.log("⑤ 拒絕與刪除");
  await post("/api/friends/request", { playerId: 乙.acc.id, token: 乙.acc.token, targetId: 丙.acc.id });
  const 拒絕 = await post("/api/friends/respond", { playerId: 丙.acc.id, token: 丙.acc.token, fromId: 乙.acc.id, accept: false });
  驗("丙拒絕乙", 拒絕.ok === true && 拒絕.accepted === false);
  const 丙的2 = await post("/api/friends/list", { playerId: 丙.acc.id, token: 丙.acc.token });
  const 乙的3 = await post("/api/friends/list", { playerId: 乙.acc.id, token: 乙.acc.token });
  驗("拒絕後丙的收件匣清空", (丙的2.incoming || []).length === 0);
  驗("拒絕後乙的寄件匣也清空", (乙的3.outgoing || []).length === 0);
  驗("拒絕沒有變成好友", !(丙的2.friends || []).some((f) => f.id === 乙.acc.id));

  await post("/api/friends/remove", { playerId: 甲.acc.id, token: 甲.acc.token, friendId: 乙.acc.id });
  const 甲的3 = await post("/api/friends/list", { playerId: 甲.acc.id, token: 甲.acc.token });
  const 乙的4 = await post("/api/friends/list", { playerId: 乙.acc.id, token: 乙.acc.token });
  驗("甲刪掉乙之後甲這邊沒有了", !(甲的3.friends || []).some((f) => f.id === 乙.acc.id));
  驗("乙那邊也同時沒有了", !(乙的4.friends || []).some((f) => f.id === 甲.acc.id));

  console.log("⑥ 改名字");
  const 改撞名 = await post("/api/profile/update", { playerId: 丙.acc.id, token: 丙.acc.token, nick: "測試甲", avatar: { emoji: "🐧", color: "#a78bfa" } });
  驗("改成別人在用的名字會被擋", 改撞名.ok === false && 改撞名.error === "nick taken");
  const 丙還在 = await post("/api/profile/verify", { playerId: 丙.acc.id, token: 丙.acc.token });
  驗("被擋之後名字沒有被改掉", 丙還在.ok === true && 丙還在.profile.nick === "測試丙", "現在是 " + (丙還在.profile && 丙還在.profile.nick));
  const 改名 = await post("/api/profile/update", { playerId: 丙.acc.id, token: 丙.acc.token, nick: "測試丁", avatar: { emoji: "🐧", color: "#a78bfa" } });
  驗("改成沒人用的名字可以", 改名.ok === true && 改名.profile.nick === "測試丁");
  const 找丁 = await post("/api/friends/search", { playerId: 甲.acc.id, token: 甲.acc.token, nick: "測試丁" });
  驗("改完用新名字找得到", 找丁.ok === true && !!找丁.found && 找丁.found.id === 丙.acc.id);
  const 找丙 = await post("/api/friends/search", { playerId: 甲.acc.id, token: 甲.acc.token, nick: "測試丙" });
  驗("舊名字已經放掉（找不到人）", 找丙.ok === true && 找丙.found === null);
  const 撿舊名 = await 建帳號("測試丙", { emoji: "🐸", color: "#ffcf5c" });
  if (額度用完(撿舊名)) 略("放掉的名字別人可以撿走"); else 驗("放掉的名字別人可以撿走", 撿舊名.ok === true);
  const 只改頭像 = await post("/api/profile/update", { playerId: 丙.acc.id, token: 丙.acc.token, nick: "測試丁", avatar: { emoji: "🎻", color: "#f87171" } });
  驗("只改頭像不會被唯一性擋住", 只改頭像.ok === true && 只改頭像.profile.avatar.emoji === "🎻");

  console.log("⑦ 舊帳號補登記名字（克耳朵）");
  const 克 = JSON.parse(await (await import("node:fs/promises")).readFile(process.env.TEMP + "/claude-acc.json", "utf8"));
  const v = await post("/api/profile/verify", { playerId: 克.id, token: 克.token });
  驗("克耳朵驗身分時把名字登記起來", v.ok === true && v.nameOwned === true, "nameOwned=" + v.nameOwned);
  const 找克 = await post("/api/friends/search", { playerId: 甲.acc.id, token: 甲.acc.token, nick: "克耳朵" });
  驗("別人搜尋「克耳朵」找得到", 找克.ok === true && !!找克.found && 找克.found.id === 克.id,
    找克.found ? 找克.found.avatar.emoji + " " + 找克.found.nick : "沒找到");
  // 這一筆預期會失敗，但萬一成功了也要進清理名單 —— 上一輪就是在這裡
  // 建出一個佔著「克耳朵」這個名字、而且沒人記得 token 的帳號。
  const 搶克 = await 建帳號("克耳朵");
  if (額度用完(搶克)) 略("別人搶不走「克耳朵」這個名字"); else 驗("別人搶不走「克耳朵」這個名字", 搶克.ok === false && 搶克.error === "nick taken");
} catch (e) {
  失敗++;
  console.log("  ✘ 測試中途炸了：" + (e && e.stack || e));
} finally {
  console.log("");
  console.log("清掉測試帳號：");
  for (const a of 建出來的) {
    const d = await post("/api/profile/delete", { playerId: a.id, token: a.token, recoveryCode: a.recoveryCode });
    console.log("  " + (d.ok ? "✔" : "✘") + " " + a.nick + " (" + a.id + ")" + (d.ok ? "" : "  " + JSON.stringify(d)));
  }
  // 刪掉之後名字要放回去，不然那些名字會永遠佔著
  for (const a of 建出來的) {
    const r = await post("/api/friends/search", { playerId: "x", token: "x", nick: a.nick });
    if (r.status !== 403) console.log("  ⚠ 預期搜尋需要 token，實際 " + r.status);
  }
  console.log("");
  console.log("通過 " + 通過 + " 項，失敗 " + 失敗 + " 項" + (跳過 ? "，跳過 " + 跳過 + " 項" : ""));
  process.exitCode = 失敗 ? 1 : 0;
}
