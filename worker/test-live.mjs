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

假時間 += 5000;
await call("/live/answer", { playerId: "p2", roundNo: 回合, pos: 正解 });

假時間 += 5000;
const rev = await call("/live/state", { playerId: "p1" });
結果["⑩揭曉"] = {
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
