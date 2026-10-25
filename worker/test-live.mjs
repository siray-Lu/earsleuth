/* LiveDO 的離線模擬賽。
   不碰 Cloudflare runtime，用假的 state / env 把回合引擎跑一遍，
   順便確認每回合結算後會正確回報長期戰績。

   跑法：npm test
*/
import { LiveDO } from "./worker.js";

const 背景工作 = [];
const 假玩家檔案 = {};
const 回報紀錄 = [];
const 榜單寫入 = [];

function makeStubState() {
  const store = new Map();
  return {
    storage: {
      async get(k) { return store.get(k); },
      async put(k, v) { store.set(k, JSON.parse(JSON.stringify(v))); },
    },
    blockConcurrencyWhile: async (fn) => { await fn(); },
    waitUntil: (p) => { 背景工作.push(p); },
  };
}

// 假的 PlayerDO：照真實的 /internal/live-result 邏輯累加，才驗得出回報對不對
const stubEnv = {
  PLAYERS: {
    idFromName: (n) => n,
    get: (name) => ({
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        回報紀錄.push({ 玩家: name, 得分: body.gained, 連對: body.streak });
        const st = 假玩家檔案[name] || (假玩家檔案[name] = { total: 0, bestStreak: 0, rounds: 0, correct: 0 });
        st.total += body.gained;
        st.rounds += 1;
        if (body.correct) st.correct += 1;
        const streakImproved = body.streak > st.bestStreak;
        if (streakImproved) st.bestStreak = body.streak;
        return new Response(JSON.stringify({
          ok: true, live: st, streakImproved,
          profile: { nick: name, avatar: { emoji: "🎤", color: "#ff5fa2" } },
        }));
      },
    }),
  },
  BOARDS: {
    idFromName: (n) => n,
    get: (name) => ({
      fetch: async (url, init) => {
        榜單寫入.push({ 榜: name, ...JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true }));
      },
    }),
  },
};

let 假時間 = 1_000_000_000_000;
const live = new LiveDO(makeStubState(), stubEnv);
await new Promise((r) => setTimeout(r, 10));
live.now = () => 假時間;

const call = async (path, body) => {
  const res = await live.fetch(new Request("https://do" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return res.json();
};

const 結果 = {};

const j1 = await call("/live/join", { playerId: "p1", nick: "小明", avatar: { emoji: "🎸", color: "#ff5fa2" } });
const j2 = await call("/live/join", { playerId: "p2", nick: "阿華", avatar: { emoji: "🦊", color: "#5fd0ff" } });
結果["①兩人進場"] = { 回合: j1.roundNo, 階段: j1.phase, 在線: j2.online, 選項數: j1.question && j1.question.options.length };
結果["②作答前不洩漏答案"] = { 有answerPos: j1.question && "answerPos" in j1.question };
結果["③倒數長度"] = { 毫秒: j1.msLeft };

const early = await call("/live/answer", { playerId: "p1", roundNo: j1.roundNo, pos: 0 });
結果["④倒數階段作答"] = { ok: early.ok, error: early.error };

假時間 += 2100;
const st = await call("/live/state", { playerId: "p1" });
結果["⑤進入作答階段"] = { 階段: st.phase, 剩餘毫秒: st.msLeft };

const 正解 = live.s.q.answerPos;
const 回合 = st.roundNo;

假時間 += 1000;
結果["⑥p1快速答對"] = await call("/live/answer", { playerId: "p1", roundNo: 回合, pos: 正解 });
結果["⑦重複作答"] = await call("/live/answer", { playerId: "p1", roundNo: 回合, pos: 正解 }).then((r) => ({ ok: r.ok, error: r.error }));
結果["⑧過期回合"] = await call("/live/answer", { playerId: "p2", roundNo: 回合 - 1, pos: 正解 }).then((r) => ({ ok: r.ok, error: r.error }));
結果["⑨亂填選項"] = await call("/live/answer", { playerId: "p2", roundNo: 回合, pos: 99 }).then((r) => ({ ok: r.ok, error: r.error }));

// p1 要持續輪詢，不然會被當成已經離開場內（4 秒沒動靜就不算在場）
假時間 += 2000;
await call("/live/state", { playerId: "p1" });
假時間 += 2000;
await call("/live/state", { playerId: "p1" });

// 最後一個人答完 —— 作答窗還有 4 秒，但應該當場揭曉
await call("/live/answer", { playerId: "p2", roundNo: 回合, pos: 正解 });
const 立刻 = await call("/live/state", { playerId: "p1" });
結果["⑩全員答完立刻揭曉"] = {
  階段: 立刻.phase,
  原本還剩: "4000 毫秒（作答窗 10 秒，用掉 6 秒）",
  說明: "舊版這時還是 play，要等滿 10 秒才揭曉",
};

const rev = 立刻;
結果["⑩b揭曉內容"] = {
  階段: rev.phase,
  公布答案: rev.question && rev.question.answerPos === 正解,
  排行: rev.board.map((b) => b.nick + " " + b.score),
  本回合: rev.lastResults.map((r) => `${r.nick} ${r.correct ? "✔" : "✘"} ${r.ms}ms +${r.gained}`),
};
結果["⑪快的人分數較高"] = rev.board[0].nick === "小明" && rev.board[0].score > rev.board[1].score;

// 連續答對好幾回合，驗證連對加成上限 400
const 每回合得分 = [];
for (let i = 0; i < 22; i++) {
  假時間 += 3100;                      // 揭曉結束 → 新回合倒數
  await call("/live/state", { playerId: "p1" });
  假時間 += 2100;                      // 倒數結束 → 作答
  await call("/live/state", { playerId: "p1" });
  const ans = live.s.q.answerPos;
  const r = live.s.roundNo;
  假時間 += 1000;                      // 固定 1 秒作答，速度分才是定值，看得出連對的影響
  await call("/live/answer", { playerId: "p1", roundNo: r, pos: ans });
  const 前 = live.s.players.p1.score;
  假時間 += 10100;
  await call("/live/state", { playerId: "p1" });
  每回合得分.push(live.s.players.p1.score - 前);
}
結果["⑫連對加成成長與上限"] = {
  前五回合得分: 每回合得分.slice(0, 5),
  最後五回合得分: 每回合得分.slice(-5),
  最高單回合: Math.max(...每回合得分),
  連對次數: live.s.players.p1.streak,
  說明: "基礎100+速度約90，加成每回合+20封頂400 → 單回合上限約 590",
};

// 等背景的戰績回報跑完
await Promise.all(背景工作);
結果["⑬長期戰績回報"] = {
  回報筆數: 回報紀錄.length,
  p1累計總分: 假玩家檔案["player:p1"] && 假玩家檔案["player:p1"].total,
  p1最高連對: 假玩家檔案["player:p1"] && 假玩家檔案["player:p1"].bestStreak,
  總分榜寫入次數: 榜單寫入.filter((w) => w.榜 === "lb:live_total").length,
  連對榜寫入次數: 榜單寫入.filter((w) => w.榜 === "lb:live_streak").length,
};

假時間 += 120000;
const ghost = await call("/live/state", { playerId: "p1" });
結果["⑭幽靈玩家清除"] = { 在線人數: ghost.online, 說明: "p2 早就沒輪詢，應只剩 p1" };

console.log(JSON.stringify(結果, null, 2));

/* ---------- 回報失敗時，那一筆不能消失 ----------
   這一段是為了守住一個具體的修正：原本是「先從佇列拿走再嘗試送」，
   送失敗那一筆就直接蒸發了，玩家的分數憑空不見。 */

let 下游正常 = false;
stubEnv.PLAYERS.get = (name) => ({
  fetch: async (url, init) => {
    if (!下游正常) throw new Error("下游掛了");
    const body = JSON.parse(init.body);
    const st = 假玩家檔案[name] || (假玩家檔案[name] = { total: 0, bestStreak: 0, rounds: 0, correct: 0 });
    st.total += body.gained;
    st.rounds += 1;
    const streakImproved = body.streak > st.bestStreak;
    if (streakImproved) st.bestStreak = body.streak;
    return new Response(JSON.stringify({
      ok: true, live: st, streakImproved,
      profile: { nick: name, avatar: { emoji: "🎤", color: "#ff5fa2" } },
    }));
  },
});

// 再打一回合，但回報的下游是壞的
假時間 += 3100; await call("/live/state", { playerId: "p1" });
假時間 += 2100; await call("/live/state", { playerId: "p1" });
await call("/live/answer", { playerId: "p1", roundNo: live.s.roundNo, pos: live.s.q.answerPos });
假時間 += 10100; await call("/live/state", { playerId: "p1" });
await Promise.all(背景工作.splice(0));

const 壞掉時佇列長度 = live.s.pending.length;
const 壞掉時的總分 = 假玩家檔案["player:p1"].total;

// 下游修好，再輪詢一次觸發補送
下游正常 = true;
假時間 += 1000;
await call("/live/state", { playerId: "p1" });
await Promise.all(背景工作.splice(0));

/* ---------- 新規則的邊界情況 ---------- */
// 回到一個乾淨的回合：等到下一回合的作答階段
const 到作答階段 = async (who) => {
  for (let i = 0; i < 20; i++) {
    const st = await call("/live/state", { playerId: who });
    if (st.phase === "play") return st;
    假時間 += 500;
  }
  throw new Error("等不到作答階段");
};

// ⑰ 中途加入的人不該卡住全場
假時間 += 3100; await call("/live/state", { playerId: "p1" });
const 第一輪 = await 到作答階段("p1");
await call("/live/join", { playerId: "p9", nick: "遲到的", avatar: { emoji: "🐧", color: "#5fd0ff" } });
await call("/live/answer", { playerId: "p1", roundNo: 第一輪.roundNo, pos: live.s.q.answerPos });
await call("/live/answer", { playerId: "p2", roundNo: 第一輪.roundNo, pos: live.s.q.answerPos });
const 遲到測試 = await call("/live/state", { playerId: "p1" });
const r17 = {
  階段: 遲到測試.phase,
  在場人數: 遲到測試.online,
  說明: "p9 是作答階段才進來的，不該把他算進參賽名單而卡住揭曉",
};

// ⑱ 關掉分頁的人不該卡住全場
假時間 += 3100; await call("/live/state", { playerId: "p1" });
const 第二輪 = await 到作答階段("p1");
// p2 從此不再輪詢（等同關掉分頁），只有 p1 作答
假時間 += 4500;
await call("/live/state", { playerId: "p1" });   // p1 還在，p2 已經超過 4 秒沒動靜
await call("/live/answer", { playerId: "p1", roundNo: live.s.roundNo, pos: live.s.q.answerPos });
const 離線測試 = await call("/live/state", { playerId: "p1" });
const r18 = {
  階段: 離線測試.phase,
  說明: "p2 超過 4 秒沒輪詢，不該讓 p1 等滿整個作答窗",
};

/* ⑲ 還有人沒答完就不能提早揭曉。
   這裡兩個人都要持續輪詢 —— 參賽名單是在「進入作答階段的那一刻」拍的，
   只有事後才補輪詢的話根本不會被列進去，那就測不到這條規則。 */
假時間 += 3100;
// p2 在前面那段 22 回合的迴圈裡完全沒輪詢，早就被當成幽靈清掉了，要重新進場
await call("/live/join", { playerId: "p2", nick: "阿華", avatar: { emoji: "🦊", color: "#5fd0ff" } });
await call("/live/state", { playerId: "p1" });
await call("/live/state", { playerId: "p2" });
for (let i = 0; i < 20; i++) {
  const a = await call("/live/state", { playerId: "p1" });
  await call("/live/state", { playerId: "p2" });
  if (a.phase === "play") break;
  假時間 += 500;
}
const 名單 = (live.s.eligible || []).slice().sort();
await call("/live/answer", { playerId: "p1", roundNo: live.s.roundNo, pos: live.s.q.answerPos });
const 還沒答完 = await call("/live/state", { playerId: "p2" });
const r19 = {
  參賽名單: 名單,
  只有p1答完時的階段: 還沒答完.phase,
  說明: "p2 在名單裡又還沒答，必須維持在作答階段",
};
// 補上 p2 的答案，應該當場轉揭曉
await call("/live/answer", { playerId: "p2", roundNo: live.s.roundNo, pos: live.s.q.answerPos });
r19.p2也答完後的階段 = (await call("/live/state", { playerId: "p1" })).phase;

console.log(JSON.stringify({
  "⑰中途加入不卡住": r17,
  "⑱離線的人不卡住": r18,
  "⑲還有人沒答就不提早": r19,
}, null, 2));

console.log(JSON.stringify({
  "⑮回報失敗時": {
    佇列有保住: 壞掉時佇列長度 > 0,
    佇列筆數: 壞掉時佇列長度,
    說明: "先移除再送的舊寫法這裡會是 0，那一筆就永遠消失了",
  },
  "⑯下游修好後補送": {
    佇列已清空: live.s.pending.length === 0,
    總分有補上: 假玩家檔案["player:p1"].total > 壞掉時的總分,
    補送前: 壞掉時的總分,
    補送後: 假玩家檔案["player:p1"].total,
  },
}, null, 2));
