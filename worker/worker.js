/* ===================== 音隙偵探 - 連線對戰後端（Cloudflare Workers + Durable Objects）=====================
   把 _serve.ps1 裡的房間邏輯（建立房間、加入、搶答、聊天室…）原封不動搬過來，
   每個房間用一個獨立的 Durable Object instance（用房號當 key）記住自己的狀態，
   這樣不管玩家連到哪個 Cloudflare 節點，同一個房號永遠會導到同一個 DO，狀態不會亂掉。
======================================================= */

// 歌庫。由根目錄的 songs.js 自動產生（npm run songs），伺服器要自己出題就得有這份。
import { SONGS } from "./songs.gen.js";

const MAX_PLAYERS = 8;
// 超過這個時間沒有來輪詢房間狀態，就當作那個人已經離開了。
// 抓 60 秒是因為瀏覽器把分頁切到背景時會把計時器降頻（Chrome 最慢到一分鐘一次），
// 抓太短會把還在玩、只是切到別的分頁的人踢掉。
const GHOST_MS = 60000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function randCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/* ---------- 個人檔案用的小工具 ---------- */

// 頭像不接受自由輸入，只能從這兩張表挑，前端的表要跟這裡一模一樣。
// 開放自由輸入的話，別人的暱稱旁邊就可能出現任何字元或超長字串。
const AVATAR_EMOJIS = [
  "🎤","🎧","🎸","🥁","🎹","🎷","🎺","🎻",
  "🕵️","🔍","🦉","🦊","🐼","🐧","🐸","🐱",
  "👑","⭐","🔥","💎","🌙","🍜","🎯","🛸",
];
const AVATAR_COLORS = [
  "#ff5fa2","#5fd0ff","#ffcf5c","#4ade80",
  "#f87171","#a78bfa","#fb923c","#2dd4bf",
];

// 接回碼刻意拿掉 0/O/1/I/L 這些看起來很像的字，不然使用者會抄錯然後怪遊戲壞掉
const RC_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomId(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => "0123456789abcdef"[b % 16]).join("");
}

function randRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(bytes, (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join("");
  return s.slice(0, 4) + "-" + s.slice(4);
}

// 使用者會怎麼抄這組碼完全不可控：小寫、沒有橫線、前後有空白都很常見，一律正規化
function normalizeRecoveryCode(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 8) return null;
  for (const ch of s) if (!RC_ALPHABET.includes(ch)) return null;
  return s.slice(0, 4) + "-" + s.slice(4);
}

function cleanNick(raw) {
  let s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (s.length > 10) s = s.slice(0, 10);
  return s || "無名氏";
}

function cleanAvatar(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  return {
    emoji: AVATAR_EMOJIS.includes(a.emoji) ? a.emoji : AVATAR_EMOJIS[0],
    color: AVATAR_COLORS.includes(a.color) ? a.color : AVATAR_COLORS[0],
  };
}

// 給別人看的版本：token 是寫入權限，接回碼等於帳號救回權，兩個都不能外流。
// 排行榜、房間名單都會用到這個函式，漏一個地方就等於把別人的檔案送出去。
function publicProfile(p) {
  return {
    id: p.id,
    nick: p.nick,
    avatar: p.avatar,
    createdAt: p.createdAt,
    stats: p.stats,
  };
}


/* ---------- 排行榜用的小工具 ---------- */

// 計時挑戰的題數與年代都是固定幾種。不照白名單擋的話，
// 隨便打一組參數就會憑空生出一張新榜，榜單會被灌成一堆垃圾。
const TIMED_COUNTS = [10, 20, 30, 40];
const ERAS = ["pre90", "post90", "mixed"];

function boardKey(era, count) {
  if (!ERAS.includes(era)) return null;
  const n = Math.floor(Number(count));
  if (!TIMED_COUNTS.includes(n)) return null;
  return era + "_" + n;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === "/api/create-room" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      // 隨機挑一個 4 位數房號；萬一撞到別的還在跑的房間（機率很低）就重試
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch("https://do/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: body.name, code }),
        });
        const data = await res.json();
        if (data.ok) return json(data);
      }
      return json({ ok: false, error: "could not allocate room code" }, 500);
    }

    // 這個要擺在通用的 /api/ 分支前面，否則會被當成「沒帶房號」直接回 400。
    // 雲端版沒有區網 IP 可以分享，回 null 讓前端改用目前網址當分享連結。
    if (path === "/api/server-info") {
      return json({ ok: true, lanIp: null, port: null, cloud: true });
    }

    // ---------- 個人檔案 ----------
    // 這一段也要擺在通用的 /api/ 轉送前面：個人檔案跟房間無關，沒有房號，
    // 掉到下面那段會直接被當成「missing code」回 400。
    if (path.startsWith("/api/profile")) {
      const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

      // 建檔：先搶一組沒人用過的接回碼，搶到了才真的把玩家檔案寫下去。
      // 順序反過來的話，接回碼萬一撞號就會有兩個人指到同一份檔案。
      if (path === "/api/profile/create" && request.method === "POST") {
        const playerId = randomId(12);
        let recoveryCode = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const cand = randRecoveryCode();
          const idx = env.PLAYERS.get(env.PLAYERS.idFromName("rc:" + cand));
          const r = await idx.fetch("https://do/idx/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playerId }),
          });
          const d = await r.json();
          if (d.ok) { recoveryCode = cand; break; }
        }
        if (!recoveryCode) return json({ ok: false, error: "could not allocate recovery code" }, 500);

        const stub = env.PLAYERS.get(env.PLAYERS.idFromName("player:" + playerId));
        const res = await stub.fetch("https://do/api/profile/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerId, recoveryCode, nick: body.nick, avatar: body.avatar }),
        });
        return json(await res.json(), res.status);
      }

      // 接回：拿接回碼去索引 DO 換回 playerId，再照一般流程往那個人的 DO 打
      let playerId = body.playerId || url.searchParams.get("playerId") || null;
      if (path === "/api/profile/restore" && request.method === "POST") {
        const rc = normalizeRecoveryCode(body.recoveryCode);
        if (!rc) return json({ ok: false, error: "bad recovery code" }, 400);
        const idx = env.PLAYERS.get(env.PLAYERS.idFromName("rc:" + rc));
        const r = await idx.fetch("https://do/idx/lookup");
        const d = await r.json().catch(() => ({ ok: false }));
        if (!d.ok) return json({ ok: false, error: "not found" }, 404);
        playerId = d.playerId;
      }

      if (!playerId) return json({ ok: false, error: "missing playerId" }, 400);
      const stub = env.PLAYERS.get(env.PLAYERS.idFromName("player:" + playerId));
      const res = await stub.fetch("https://do" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, playerId }),
      });
      return json(await res.json().catch(() => ({ ok: false, error: "bad upstream response" })), res.status);
    }

    // ---------- 排行榜 ----------
    // 同樣要擺在通用 /api/ 轉送前面（排行榜沒有房號）
    if (path.startsWith("/api/leaderboard")) {
      const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

      // 讀榜：公開資料，不需要身分。帶 playerId 的話會順便算出「我第幾名」。
      if (path === "/api/leaderboard") {
        const key = boardKey(
          url.searchParams.get("era") || body.era,
          url.searchParams.get("count") || body.count
        );
        if (!key) return json({ ok: false, error: "bad board" }, 400);
        const me = body.playerId || url.searchParams.get("playerId") || "";
        const stub = env.BOARDS.get(env.BOARDS.idFromName("lb:" + key));
        const res = await stub.fetch("https://do/list?playerId=" + encodeURIComponent(me));
        return json(await res.json().catch(() => ({ ok: false })), res.status);
      }

      // 全場競速的長期榜。這兩張榜沒有對外的寫入路徑，只有 LiveDO 在每回合結算後寫進去，
      // 所以這裡只需要讀。
      if (path === "/api/leaderboard/live") {
        const kind = url.searchParams.get("kind") || body.kind;
        if (kind !== "total" && kind !== "streak") return json({ ok: false, error: "bad kind" }, 400);
        const me = body.playerId || url.searchParams.get("playerId") || "";
        const stub = env.BOARDS.get(env.BOARDS.idFromName("lb:live_" + kind));
        const res = await stub.fetch("https://do/list?playerId=" + encodeURIComponent(me));
        return json(await res.json().catch(() => ({ ok: false })), res.status);
      }

      // 上傳成績：先跟玩家自己的 DO 驗 token，驗過了才准動榜單。
      // 少了這一步，任何人知道別人的 playerId 就能替他灌一筆假成績。
      if (path === "/api/leaderboard/submit" && request.method === "POST") {
        const key = boardKey(body.era, body.count);
        if (!key) return json({ ok: false, error: "bad board" }, 400);

        const count = Math.floor(Number(body.count));
        const ms = Math.floor(Number(body.ms));
        // 擋一下明顯不可能的成績。一題至少要聽、要想、要按，平均 0.8 秒內答完整輪不是人類。
        // 這只擋得掉隨手亂送的數字；前端本來就不可信任，真要防得靠伺服器出題才行。
        if (!(ms > count * 800) || ms > 3 * 3600 * 1000) {
          return json({ ok: false, error: "implausible time" }, 400);
        }

        const pStub = env.PLAYERS.get(env.PLAYERS.idFromName("player:" + body.playerId));
        const vRes = await pStub.fetch("https://do/api/profile/timed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: body.token, boardKey: key, ms }),
        });
        const v = await vRes.json().catch(() => ({ ok: false, error: "bad upstream response" }));
        if (!v.ok) return json(v, vRes.status);

        // 榜單上存的是當下的暱稱與頭像。之後改名不會回頭改已經上榜的那一筆，
        // 但下次再破自己的紀錄時就會一起更新。
        const stub = env.BOARDS.get(env.BOARDS.idFromName("lb:" + key));
        const res = await stub.fetch("https://do/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerId: body.playerId, nick: v.profile.nick, avatar: v.profile.avatar, ms }),
        });
        const d = await res.json().catch(() => ({ ok: false, error: "bad upstream response" }));
        return json(Object.assign({}, d, { isPersonalBest: v.isBest }), res.status);
      }

      // 把自己從某張榜上撤下來。要帶 token，所以只動得了自己那一筆。
      if (path === "/api/leaderboard/forget" && request.method === "POST") {
        const key = boardKey(body.era, body.count);
        if (!key) return json({ ok: false, error: "bad board" }, 400);

        const pStub = env.PLAYERS.get(env.PLAYERS.idFromName("player:" + body.playerId));
        const vRes = await pStub.fetch("https://do/api/profile/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: body.token }),
        });
        const v = await vRes.json().catch(() => ({ ok: false, error: "bad upstream response" }));
        if (!v.ok) return json(v, vRes.status);

        const stub = env.BOARDS.get(env.BOARDS.idFromName("lb:" + key));
        const res = await stub.fetch("https://do/forget", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerId: body.playerId }),
        });
        return json(await res.json().catch(() => ({ ok: false, error: "bad upstream response" })), res.status);
      }

      return json({ ok: false, error: "not found" }, 404);
    }

    // ---------- 全場同題即時競速 ----------
    // 全站只有一個場次（idFromName 固定用 live:main）。分年代開三個頻道的話，
    // 本來人就不多還被拆三份，每個頻道都只剩自己一個人在跑。
    if (path.startsWith("/api/live/")) {
      const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
      if (!body.playerId) return json({ ok: false, error: "missing playerId" }, 400);

      // 進場與作答都要驗身分。不驗的話，知道別人 playerId 就能替他送出錯誤答案。
      // 查詢狀態不驗，那隻是唯讀的。
      let nick = null;
      let avatar = null;
      if (path === "/api/live/join" || path === "/api/live/answer") {
        const pStub = env.PLAYERS.get(env.PLAYERS.idFromName("player:" + body.playerId));
        const vRes = await pStub.fetch("https://do/api/profile/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: body.token }),
        });
        const v = await vRes.json().catch(() => ({ ok: false, error: "bad upstream response" }));
        if (!v.ok) return json(v, vRes.status);
        // 暱稱與頭像一律以伺服器上的為準，不採信前端送來的，免得有人冒名
        nick = v.profile.nick;
        avatar = v.profile.avatar;
      }

      const stub = env.LIVE.get(env.LIVE.idFromName("live:main"));
      const res = await stub.fetch("https://do" + path.replace("/api", ""), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({}, body, { nick, avatar })),
      });
      return json(await res.json().catch(() => ({ ok: false, error: "bad upstream response" })), res.status);
    }

    if (path.startsWith("/api/")) {
      let code = url.searchParams.get("code");
      let bodyText = null;
      if (request.method === "POST") {
        bodyText = await request.text();
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed && parsed.code) code = parsed.code;
        } catch (e) {}
      }
      if (!code) return json({ ok: false, error: "missing code" }, 400);

      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const forwardInit = { method: request.method, headers: { "Content-Type": "application/json" } };
      if (bodyText !== null) forwardInit.body = bodyText;
      const res = await stub.fetch("https://do" + path + url.search, forwardInit);
      const data = await res.json().catch(() => ({ ok: false, error: "bad upstream response" }));
      return json(data, res.status);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.room = null;
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get("room")) || null;
    });
  }

  now() {
    return Date.now();
  }

  async save() {
    if (this.room) await this.state.storage.put("room", this.room);
  }

  newPlayerId() {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  }

  // 把「早就離線但沒送出 leave-room」的人清掉（例如瀏覽器當掉、斷網）。
  // 不清的話，那個人重新加入就會在名單裡出現兩次。
  pruneGhosts() {
    const room = this.room;
    if (!room) return;
    const now = this.now();
    const ids = Object.keys(room.players);
    if (ids.length <= 1) return; // 只剩一個人就別踢了，不然房間會直接空掉
    let removed = false;
    for (const id of ids) {
      const p = room.players[id];
      if (p.lastSeen && now - p.lastSeen > GHOST_MS) {
        delete room.players[id];
        delete room.answers[id];
        removed = true;
      }
    }
    if (removed && !room.players[room.hostPlayerId]) {
      room.hostPlayerId = Object.keys(room.players)[0] || room.hostPlayerId;
    }
  }

  // 房主不用按準備（他按難度開始就等於準備好了），只看其他人。
  everyoneReady() {
    const room = this.room;
    if (!room) return false;
    const others = Object.keys(room.players).filter((id) => id !== room.hostPlayerId);
    if (others.length === 0) return false;
    return others.every((id) => room.players[id].ready);
  }

  clearReady() {
    if (!this.room) return;
    for (const id of Object.keys(this.room.players)) this.room.players[id].ready = false;
  }

  touch(playerId) {
    if (this.room && playerId && this.room.players[playerId]) {
      this.room.players[playerId].lastSeen = this.now();
    }
  }

  advancePhase() {
    const room = this.room;
    if (!room) return;
    const now = this.now();
    const elapsed = now - room.phaseStartedAt;

    if (room.phase === "countdown") {
      if (elapsed >= 3000) {
        room.phase = "playing";
        room.phaseStartedAt = now;
        room.answers = {};
      }
      return;
    }

    if (room.phase === "playing") {
      // 搶答制：只要有人答對就立刻公布，不用等全部人都作答完
      const keys = Object.keys(room.answers);
      const anyCorrect = keys.some((k) => room.answers[k].correct);
      const allAnswered = keys.length >= Object.keys(room.players).length;
      const clipMs = (Number(room.clipSeconds[room.index]) || 0) * 1000 + 3000;
      if (anyCorrect || allAnswered || elapsed >= clipMs) {
        let winnerId = null;
        let bestMs = Infinity;
        for (const k of keys) {
          const a = room.answers[k];
          if (a.correct && a.atMs < bestMs) {
            bestMs = a.atMs;
            winnerId = k;
          }
        }
        if (winnerId && room.players[winnerId]) room.players[winnerId].score++;
        room.lastRoundWinnerId = winnerId;
        room.phase = "revealed";
        room.phaseStartedAt = now;
      }
      return;
    }

    if (room.phase === "revealed") {
      if (elapsed >= 4000) {
        if (room.index >= room.songIds.length - 1) {
          room.phase = "finished";
        } else {
          room.index++;
          room.phase = "countdown";
          room.phaseStartedAt = now;
          room.answers = {};
        }
      }
    }
  }

  publicState() {
    const room = this.room;
    const players = Object.keys(room.players).map((id) => ({
      id,
      name: room.players[id].name,
      score: room.players[id].score,
      ready: !!room.players[id].ready,
      answered: Object.prototype.hasOwnProperty.call(room.answers, id),
    }));
    const winnerName =
      room.lastRoundWinnerId && room.players[room.lastRoundWinnerId]
        ? room.players[room.lastRoundWinnerId].name
        : null;
    return {
      ok: true,
      code: room.code,
      phase: room.phase,
      index: room.index,
      total: room.songIds.length,
      correctSongId: room.songIds[room.index] ?? null,
      clipSeconds: room.clipSeconds[room.index] ?? null,
      start: room.starts[room.index] ?? null,
      phaseStartedAt: room.phaseStartedAt,
      serverNow: this.now(),
      hostPlayerId: room.hostPlayerId,
      allReady: this.everyoneReady(),
      players,
      lastRoundWinnerId: room.lastRoundWinnerId,
      lastRoundWinnerName: winnerName,
      chat: room.chat,
    };
  }

  json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    let body = {};
    if (request.method === "POST") body = await request.json().catch(() => ({}));

    if (path === "/init") {
      if (this.room) return this.json({ ok: false, error: "exists" });
      const playerId = this.newPlayerId();
      const name = (body.name && String(body.name).trim()) || "Player1";
      this.room = {
        code: body.code,
        hostPlayerId: playerId,
        players: { [playerId]: { name, score: 0, ready: false, lastSeen: this.now() } },
        nextPlayerNum: 2,
        diffKey: null,
        songIds: [],
        clipSeconds: [],
        starts: [],
        index: 0,
        phase: "lobby",
        phaseStartedAt: this.now(),
        answers: {},
        lastRoundWinnerId: null,
        chat: [],
        chatSeq: 0,
      };
      await this.save();
      return this.json({ ok: true, code: this.room.code, playerId, name });
    }

    if (!this.room) return this.json({ ok: false, error: "room not found" }, 404);
    const room = this.room;

    if (path === "/api/join-room") {
      this.pruneGhosts();
      // 同一個人重新連上來（重新整理、不小心關掉分頁又回來）就沿用原本的位子，
      // 不要再開一個新的，否則名單上會出現兩個同樣的人。
      const rejoinId = body.rejoinId && String(body.rejoinId);
      if (rejoinId && room.players[rejoinId]) {
        const nm = (body.name && String(body.name).trim());
        if (nm) room.players[rejoinId].name = nm;
        room.players[rejoinId].lastSeen = this.now();
        await this.save();
        return this.json({ ok: true, playerId: rejoinId, name: room.players[rejoinId].name, rejoined: true });
      }
      if (room.phase !== "lobby") return this.json({ ok: false, error: "already started" }, 409);
      if (Object.keys(room.players).length >= MAX_PLAYERS)
        return this.json({ ok: false, error: "room full" }, 409);
      const playerId = this.newPlayerId();
      const name = (body.name && String(body.name).trim()) || "Player" + room.nextPlayerNum;
      room.nextPlayerNum++;
      room.players[playerId] = { name, score: 0, ready: false, lastSeen: this.now() };
      await this.save();
      return this.json({ ok: true, playerId, name });
    }

    if (path === "/api/start-game") {
      if (body.playerId !== room.hostPlayerId) return this.json({ ok: false, error: "only host can start" }, 403);
      if (Object.keys(room.players).length < 2)
        return this.json({ ok: false, error: "need at least 2 players" }, 409);
      if (!this.everyoneReady())
        return this.json({ ok: false, error: "not everyone is ready" }, 409);
      if (room.phase !== "lobby") {
        return this.json(this.publicState());
      }
      room.diffKey = body.diffKey;
      room.songIds = Array.isArray(body.songIds) ? body.songIds : [];
      room.clipSeconds = Array.isArray(body.clipSeconds) ? body.clipSeconds : [];
      room.starts = Array.isArray(body.starts) ? body.starts : [];
      room.index = 0;
      room.phase = "countdown";
      room.phaseStartedAt = this.now();
      room.answers = {};
      await this.save();
      return this.json(this.publicState());
    }

    if (path === "/api/set-ready") {
      const pid = body.playerId;
      if (!room.players[pid]) return this.json({ ok: false, error: "not in room" }, 403);
      room.players[pid].ready = !!body.ready;
      room.players[pid].lastSeen = this.now();
      await this.save();
      return this.json(this.publicState());
    }

    if (path === "/api/room-state") {
      // 每次輪詢都當成一次「我還在」的心跳
      this.touch(url.searchParams.get("playerId"));
      this.pruneGhosts();
      this.advancePhase();
      await this.save();
      return this.json(this.publicState());
    }

    if (path === "/api/submit-answer") {
      this.touch(body.playerId);
      this.advancePhase();
      const playerId = body.playerId;
      if (room.phase === "playing" && room.players[playerId] && !room.answers[playerId]) {
        const atMs = this.now() - room.phaseStartedAt;
        const correct = String(body.songId) === String(room.songIds[room.index]);
        room.answers[playerId] = { songId: body.songId, atMs, correct };
        this.advancePhase();
      }
      await this.save();
      return this.json(this.publicState());
    }

    if (path === "/api/return-to-lobby") {
      // 只有在上一局已經結束時才能重置房間。
      // 否則上一局卡在結算畫面的人按下「回到房間」，會把別人正在玩的這一局整個洗掉。
      if (room.phase !== "finished") {
        return this.json(this.publicState());
      }
      room.phase = "lobby";
      room.phaseStartedAt = this.now();
      room.index = 0;
      room.songIds = [];
      room.clipSeconds = [];
      room.starts = [];
      room.answers = {};
      room.lastRoundWinnerId = null;
      for (const pid of Object.keys(room.players)) room.players[pid].score = 0;
      this.clearReady(); // 下一局要重新按準備
      await this.save();
      return this.json(this.publicState());
    }

    if (path === "/api/leave-room") {
      const playerId = body.playerId;
      if (room.players[playerId]) delete room.players[playerId];
      // 連他這一輪的作答一起清掉，否則「是不是大家都答完了」會多算一票
      delete room.answers[playerId];
      if (Object.keys(room.players).length === 0) {
        this.room = null;
        await this.state.storage.deleteAll();
        return this.json({ ok: true });
      }
      if (room.hostPlayerId === playerId) room.hostPlayerId = Object.keys(room.players)[0];
      await this.save();
      return this.json({ ok: true });
    }

    if (path === "/api/send-chat") {
      const playerId = body.playerId;
      if (!room.players[playerId]) return this.json({ ok: false, error: "not in room" }, 403);
      let text = String(body.text || "").trim();
      if (text.length > 200) text = text.slice(0, 200);
      if (text.length > 0) {
        room.chatSeq++;
        room.chat.push({ id: room.chatSeq, playerId, name: room.players[playerId].name, text, ts: this.now() });
        if (room.chat.length > 50) room.chat = room.chat.slice(room.chat.length - 50);
      }
      await this.save();
      return this.json({ ok: true });
    }

    return this.json({ ok: false, error: "not found" }, 404);
  }
}

/* ===================== 個人檔案的 Durable Object =====================
   同一個 class 被拿來當兩種東西用，靠 key 的前綴分辨：
     player:<playerId>  → 真正的玩家檔案
     rc:<接回碼>         → 只存一個指標，把接回碼對回 playerId
   會這樣設計是因為 DO 只能用 key 直接定位，沒有「查詢」這種操作，
   想用接回碼找人就得自己做一層索引。
======================================================= */
export class PlayerDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json().catch(() => ({}));

    /* ---- 接回碼索引 ---- */
    if (path === "/idx/claim") {
      // 已經被佔走就回 false，讓上層換一組再試，絕對不能覆蓋
      const owner = await this.state.storage.get("owner");
      if (owner) return json({ ok: false, error: "taken" });
      await this.state.storage.put("owner", body.playerId);
      return json({ ok: true });
    }
    if (path === "/idx/lookup") {
      const owner = await this.state.storage.get("owner");
      return owner ? json({ ok: true, playerId: owner }) : json({ ok: false, error: "not found" }, 404);
    }

    /* ---- 玩家檔案 ---- */
    if (path === "/api/profile/create") {
      const profile = {
        id: body.playerId,
        nick: cleanNick(body.nick),
        avatar: cleanAvatar(body.avatar),
        recoveryCode: body.recoveryCode,
        token: randomId(32),
        createdAt: Date.now(),
        stats: { games: 0, correct: 0, total: 0, timedBest: {} },
      };
      await this.state.storage.put("profile", profile);
      // 建檔這一次才會把 token 跟接回碼一起交出去，之後任何查詢都不會再送
      return json({ ok: true, profile: publicProfile(profile), token: profile.token, recoveryCode: profile.recoveryCode });
    }

    const profile = await this.state.storage.get("profile");
    if (!profile) return json({ ok: false, error: "no profile" }, 404);

    if (path === "/api/profile") {
      return json({ ok: true, profile: publicProfile(profile) });
    }

    if (path === "/api/profile/restore") {
      // 拿得出接回碼就等於證明是本人，這時要把 token 一起給回去，新裝置才寫得動
      return json({ ok: true, profile: publicProfile(profile), token: profile.token, recoveryCode: profile.recoveryCode });
    }

    // 一場遊戲打完之後累加統計。這裡刻意不接受前端直接送「總場次／總答對數」，
    // 只收單場結果再自己加，不然改個數字就能把統計灌成任何值。
    // （單場的上限也擋一下，計時挑戰最多 40 題，抓 200 已經很寬鬆了）
    if (path === "/api/profile/stats") {
      if (body.token !== profile.token) return json({ ok: false, error: "bad token" }, 403);
      const total = Math.floor(Number(body.total) || 0);
      const correct = Math.floor(Number(body.correct) || 0);
      if (total < 0 || total > 200 || correct < 0 || correct > total) {
        return json({ ok: false, error: "bad result" }, 400);
      }
      profile.stats.games += 1;
      profile.stats.correct += correct;
      profile.stats.total += total;
      await this.state.storage.put("profile", profile);
      return json({ ok: true, profile: publicProfile(profile) });
    }

    // 計時挑戰成績。先在玩家自己的 DO 判斷「是不是個人新猷」，
    // 是的話才讓上層去動榜單；順便這一步也等於驗過 token 了。
    // 只驗身分、不改任何東西。給「撤下排行榜紀錄」這種需要確認是本人的操作用。
    // 全場競速的長期戰績。這條路徑刻意不驗 token —— 它只有 LiveDO 內部叫得到，
    // 對外的轉送只會把 /api/... 打進這個 DO，碰不到 /internal/ 開頭的路徑。
    if (path === "/internal/live-result") {
      if (!profile.stats.live) profile.stats.live = { total: 0, bestStreak: 0, rounds: 0, correct: 0 };
      const L = profile.stats.live;
      // 就算是內部呼叫也夾一下範圍。哪天這個邏輯被改壞，
      // 至少不會把某個人的總分寫成天文數字，整張榜就廢了。
      const gained = Math.max(0, Math.min(2000, Math.floor(Number(body.gained) || 0)));
      const streak = Math.max(0, Math.min(9999, Math.floor(Number(body.streak) || 0)));
      L.total += gained;
      L.rounds += 1;
      if (body.correct) L.correct += 1;
      const streakImproved = streak > L.bestStreak;
      if (streakImproved) L.bestStreak = streak;
      await this.state.storage.put("profile", profile);
      return json({ ok: true, live: L, streakImproved, profile: publicProfile(profile) });
    }

    if (path === "/api/profile/verify") {
      if (body.token !== profile.token) return json({ ok: false, error: "bad token" }, 403);
      return json({ ok: true, profile: publicProfile(profile) });
    }

    if (path === "/api/profile/timed") {
      if (body.token !== profile.token) return json({ ok: false, error: "bad token" }, 403);
      const ms = Math.floor(Number(body.ms));
      if (!(ms > 0)) return json({ ok: false, error: "bad time" }, 400);
      if (!profile.stats.timedBest) profile.stats.timedBest = {};
      const prev = profile.stats.timedBest[body.boardKey];
      const isBest = !prev || ms < prev;
      if (isBest) {
        profile.stats.timedBest[body.boardKey] = ms;
        await this.state.storage.put("profile", profile);
      }
      return json({ ok: true, isBest, profile: publicProfile(profile) });
    }

    if (path === "/api/profile/update") {
      if (body.token !== profile.token) return json({ ok: false, error: "bad token" }, 403);
      if (body.nick != null) profile.nick = cleanNick(body.nick);
      if (body.avatar != null) profile.avatar = cleanAvatar(body.avatar);
      await this.state.storage.put("profile", profile);
      return json({ ok: true, profile: publicProfile(profile) });
    }

    return json({ ok: false, error: "not found" }, 404);
  }
}

/* ===================== 排行榜的 Durable Object =====================
   一張榜一個 instance，key 是「年代_題數」，例如 lb:mixed_10。
   分開存而不是全部塞一顆，是因為每次上傳都要重排整張榜，
   擠在一起會讓所有年代的玩家互相排隊等同一個物件。
======================================================= */

// 榜單留這麼多筆，但只回傳前面這些。留多一點是為了讓排在中段的人
// 還看得到自己第幾名，不然一破 50 名就變成「查無名次」。
const BOARD_KEEP = 200;
const BOARD_SHOW = 50;

export class LeaderboardDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const entries = (await this.state.storage.get("entries")) || [];

    if (path === "/list") {
      const playerId = url.searchParams.get("playerId") || "";
      const i = playerId ? entries.findIndex((e) => e.playerId === playerId) : -1;
      return json({
        ok: true,
        top: entries.slice(0, BOARD_SHOW),
        myRank: i >= 0 ? i + 1 : null,
        myEntry: i >= 0 ? entries[i] : null,
        total: entries.length,
      });
    }

    if (path === "/forget") {
      const body = await request.json().catch(() => ({}));
      const i = entries.findIndex((e) => e.playerId === body.playerId);
      if (i < 0) return json({ ok: true, removed: false, total: entries.length });
      entries.splice(i, 1);
      await this.state.storage.put("entries", entries);
      return json({ ok: true, removed: true, total: entries.length });
    }

    // 全場競速的長期榜（總分、最高連對）。跟計時挑戰榜相反，這裡是數字越大越好。
    // 一樣只有 LiveDO 內部叫得到，對外沒有可以寫進來的路徑。
    if (path === "/internal/live-submit") {
      const body = await request.json().catch(() => ({}));
      const value = Math.floor(Number(body.value) || 0);
      const i = entries.findIndex((e) => e.playerId === body.playerId);
      if (i >= 0) {
        if ((entries[i].value || 0) >= value) {
          return json({ ok: true, improved: false, rank: i + 1 });
        }
        entries.splice(i, 1);
      }
      entries.push({
        playerId: body.playerId, nick: body.nick, avatar: body.avatar,
        value, at: Date.now(),
      });
      entries.sort((a, b) => b.value - a.value);
      if (entries.length > BOARD_KEEP) entries.length = BOARD_KEEP;
      await this.state.storage.put("entries", entries);
      return json({
        ok: true, improved: true,
        rank: entries.findIndex((e) => e.playerId === body.playerId) + 1,
      });
    }

    if (path === "/submit") {
      const body = await request.json().catch(() => ({}));
      const i = entries.findIndex((e) => e.playerId === body.playerId);

      // 一個人只留最好的一筆。不去重的話，常玩的人會把整張榜洗成自己的名字，
      // 榜單就失去意義了。
      if (i >= 0) {
        if (entries[i].ms <= body.ms) {
          return json({
            ok: true, improved: false, rank: i + 1, myRank: i + 1,
            top: entries.slice(0, BOARD_SHOW), total: entries.length,
          });
        }
        entries.splice(i, 1);
      }

      entries.push({
        playerId: body.playerId,
        nick: body.nick,
        avatar: body.avatar,
        ms: body.ms,
        at: Date.now(),
      });
      entries.sort((a, b) => a.ms - b.ms);
      if (entries.length > BOARD_KEEP) entries.length = BOARD_KEEP;
      await this.state.storage.put("entries", entries);

      const rank = entries.findIndex((e) => e.playerId === body.playerId) + 1;
      return json({
        ok: true, improved: true, rank: rank || null, myRank: rank || null,
        top: entries.slice(0, BOARD_SHOW), total: entries.length,
      });
    }

    return json({ ok: false, error: "not found" }, 404);
  }
}

/* ===================== 全場同題即時競速的 Durable Object =====================
   跟房間模式最大的不同：沒有房主。題目由伺服器自己出、自己判卷，
   前端只能回報「我選了第幾個選項」，分數算在伺服器這邊。

   回合是用時間戳推進的，不靠 alarm：每次有人來輪詢就把「該過去的階段」補跑完。
   這樣沒人在線時整個物件是完全靜止的，不會空燒。

   一個誠實的但書：前端本來就有完整歌庫（要有 videoId 才播得動），
   所以打開開發者工具的人查得到答案。伺服器判卷擋得住「直接 POST 假分數」，
   擋不住「自己查答案再按下去」。要真的擋住得走串流代理，那是另一個等級的工程。
======================================================= */

const LIVE_COUNTDOWN_MS = 2000;   // 準備
const LIVE_PLAY_MS = 10000;       // 播放 + 作答窗（片段 8 秒，播完再留 2 秒作答）
const LIVE_REVEAL_MS = 3000;      // 揭曉 + 看排行
const LIVE_CLIP_SECONDS = 8;
const LIVE_TIER = "hard";

// 超過這個時間沒來輪詢就當作離開了。Chrome 會把背景分頁的計時器降頻到約一分鐘一次，
// 抓太短會把「只是切到別的 App」的人踢掉，連帶清掉他的分數。
const LIVE_GHOST_MS = 90000;
const LIVE_BOARD_SHOW = 20;

// 全場沒人的時候不需要繼續跑回合。超過這個時間才有人回來，
// 就當作重新開賽，而不是把中間幾百回合補跑完。
const LIVE_IDLE_MS = 5 * 60 * 1000;

function livePhaseDuration(phase) {
  if (phase === "countdown") return LIVE_COUNTDOWN_MS;
  if (phase === "play") return LIVE_PLAY_MS;
  return LIVE_REVEAL_MS;
}

export class LiveDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.s = null;
    // 每回合結算完要回報給玩家檔案與長期榜單，先在這裡排隊，
    // 等回應送出之後再用 waitUntil 慢慢送，不要讓玩家等我們寫統計。
    this.pending = [];
    this.state.blockConcurrencyWhile(async () => {
      this.s = (await this.state.storage.get("live")) || null;
    });
  }

  now() {
    return Date.now();
  }

  async save() {
    if (this.s) await this.state.storage.put("live", this.s);
  }

  fresh() {
    return {
      roundNo: 0,
      phase: "reveal",
      phaseStartedAt: 0,
      q: null,
      players: {},
      answers: {},
      lastResults: [],
    };
  }

  // 伺服器自己出題。選項也在這裡定好順序，全場看到的是同一份，
  // 交給前端各自洗牌的話每個人選項位置不同，答題速度就沒有可比性了。
  newQuestion() {
    const song = SONGS[Math.floor(Math.random() * SONGS.length)];
    const others = [];
    const used = new Set([song.title]);
    let guard = 0;
    while (others.length < 3 && guard++ < 200) {
      const cand = SONGS[Math.floor(Math.random() * SONGS.length)];
      if (used.has(cand.title)) continue;
      used.add(cand.title);
      others.push(cand.title);
    }

    const options = [song.title, ...others];
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }

    return {
      songId: song.id,
      tier: LIVE_TIER,
      clipSeconds: LIVE_CLIP_SECONDS,
      options,
      answerPos: options.indexOf(song.title),
      correctTitle: song.title,
      correctArtist: song.artist,
    };
  }

  advance() {
    if (!this.s) this.s = this.fresh();
    const s = this.s;

    // 久無人跡：直接開新的一回合，不要把空窗期的回合全部補跑
    if (s.phaseStartedAt && this.now() - s.phaseStartedAt > LIVE_IDLE_MS) {
      s.roundNo += 1;
      s.q = this.newQuestion();
      s.answers = {};
      s.lastResults = [];
      s.phase = "countdown";
      s.phaseStartedAt = this.now();
      this.pruneGhosts();
      return;
    }

    let guard = 0;
    while (guard++ < 60) {
      if (this.now() - s.phaseStartedAt < livePhaseDuration(s.phase)) break;
      this.nextPhase();
    }
    this.pruneGhosts();
  }

  nextPhase() {
    const s = this.s;
    if (s.phase === "countdown") {
      s.phase = "play";
    } else if (s.phase === "play") {
      this.settle();
      s.phase = "reveal";
    } else {
      s.roundNo += 1;
      s.q = this.newQuestion();
      s.answers = {};
      s.phase = "countdown";
    }
    s.phaseStartedAt = this.now();
  }

  // 作答窗結束，把這一回合結清
  settle() {
    const s = this.s;
    if (!s.q) return;
    const results = [];
    for (const pid of Object.keys(s.players)) {
      const p = s.players[pid];
      const a = s.answers[pid];
      if (a && a.correct) {
        // 基礎分 + 速度分：越早按分數越高。再加連對獎勵（每連一題 +20，最多 400），
        // 連對權重刻意壓過速度，讓「一路穩穩答對」比「偶爾手快」更有價值。
        const speedRatio = Math.max(0, 1 - a.ms / LIVE_PLAY_MS);
        const bonus = Math.min(400, p.streak * 20);
        const gained = 100 + Math.round(100 * speedRatio) + bonus;
        p.score += gained;
        p.streak += 1;
        p.best = Math.max(p.best || 0, gained);
        results.push({ playerId: pid, nick: p.nick, avatar: p.avatar, correct: true, ms: a.ms, gained });
        // 只有真的有得分才回報。全部都報的話，一整排掛著發呆的人
        // 每 22 秒就會產生一輪無意義的寫入。
        this.pending.push({ playerId: pid, gained, streak: p.streak, correct: true });
      } else {
        p.streak = 0;
        results.push({ playerId: pid, nick: p.nick, avatar: p.avatar, correct: false, ms: a ? a.ms : null, gained: 0 });
        if (a) this.pending.push({ playerId: pid, gained: 0, streak: 0, correct: false });
      }
    }
    // 答對的排前面、快的排前面，這樣揭曉時第一行就是本回合最快的人
    results.sort((x, y) => (y.correct - x.correct) || ((x.ms ?? 1e9) - (y.ms ?? 1e9)));
    s.lastResults = results.slice(0, LIVE_BOARD_SHOW);
  }

  // 把結算結果寫進玩家檔案與長期榜單。
  // 免費方案一個請求最多 50 個 subrequest，所以一次只處理固定筆數，
  // 剩下的留到下一次輪詢再送 —— 寧可統計慢幾秒，也不要把額度用光害正常請求失敗。
  async flushReports() {
    const batch = this.pending.splice(0, 8);
    for (const r of batch) {
      try {
        const pStub = this.env.PLAYERS.get(this.env.PLAYERS.idFromName("player:" + r.playerId));
        const res = await pStub.fetch("https://do/internal/live-result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(r),
        });
        const d = await res.json().catch(() => ({ ok: false }));
        if (!d.ok) continue;

        // 總分只有得分時才需要重寫；連對紀錄只有破自己紀錄時才動榜
        if (r.gained > 0) await this.submitLiveBoard("live_total", r.playerId, d.profile, d.live.total);
        if (d.streakImproved) await this.submitLiveBoard("live_streak", r.playerId, d.profile, d.live.bestStreak);
      } catch (e) {
        // 統計寫失敗不該影響比賽本身，這一筆丟掉就算了
      }
    }
  }

  async submitLiveBoard(name, playerId, profile, value) {
    const stub = this.env.BOARDS.get(this.env.BOARDS.idFromName("lb:" + name));
    await stub.fetch("https://do/internal/live-submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, nick: profile.nick, avatar: profile.avatar, value }),
    });
  }

  pruneGhosts() {
    const s = this.s;
    const now = this.now();
    for (const pid of Object.keys(s.players)) {
      if (now - (s.players[pid].lastSeen || 0) > LIVE_GHOST_MS) delete s.players[pid];
    }
  }

  scoreboard() {
    const s = this.s;
    return Object.keys(s.players)
      .map((pid) => ({
        playerId: pid,
        nick: s.players[pid].nick,
        avatar: s.players[pid].avatar,
        score: s.players[pid].score,
        streak: s.players[pid].streak,
      }))
      .sort((a, b) => b.score - a.score);
  }

  publicState(pid) {
    const s = this.s;
    const revealing = s.phase === "reveal";
    const msLeft = Math.max(0, livePhaseDuration(s.phase) - (this.now() - s.phaseStartedAt));
    const board = this.scoreboard();
    const myIndex = board.findIndex((e) => e.playerId === pid);

    let question = null;
    if (s.q) {
      question = {
        songId: s.q.songId,
        tier: s.q.tier,
        clipSeconds: s.q.clipSeconds,
        options: s.q.options,
      };
      // answerPos 在作答階段絕對不能送出去，送了等於直接公布答案
      if (revealing) {
        question.answerPos = s.q.answerPos;
        question.correctTitle = s.q.correctTitle;
        question.correctArtist = s.q.correctArtist;
      }
    }

    const myAnswer = s.answers[pid] || null;

    return {
      ok: true,
      roundNo: s.roundNo,
      phase: s.phase,
      msLeft,
      question,
      online: board.length,
      board: board.slice(0, LIVE_BOARD_SHOW),
      myRank: myIndex >= 0 ? myIndex + 1 : null,
      me: myIndex >= 0 ? board[myIndex] : null,
      myAnswer: myAnswer ? { pos: myAnswer.pos, correct: revealing ? myAnswer.correct : null } : null,
      lastResults: revealing ? s.lastResults : [],
      answered: Object.keys(s.answers).length,
    };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json().catch(() => ({}));
    const pid = body.playerId;

    // 先幫呼叫者蓋時間戳，再推進回合。順序反過來的話，advance() 裡的
    // pruneGhosts 會把「剛回來、正在發這個請求的人」自己清掉 ——
    // 手機切到別的 App 再切回來就會發生，分數直接歸零。
    if (this.s && this.s.players[pid]) this.s.players[pid].lastSeen = this.now();

    this.advance();

    // 回應先送出去，統計在背景慢慢寫。玩家不該為了我們更新排行榜而多等一輪。
    if (this.pending.length) this.state.waitUntil(this.flushReports());

    if (path === "/live/join") {
      if (!this.s.players[pid]) {
        this.s.players[pid] = {
          nick: body.nick, avatar: body.avatar,
          score: 0, streak: 0, best: 0, lastSeen: this.now(),
        };
      } else {
        // 重新加入時順便更新名字與頭像（中途改過的話）
        this.s.players[pid].nick = body.nick;
        this.s.players[pid].avatar = body.avatar;
        this.s.players[pid].lastSeen = this.now();
      }
      await this.save();
      return json(this.publicState(pid));
    }

    if (path === "/live/state") {
      if (this.s.players[pid]) this.s.players[pid].lastSeen = this.now();
      await this.save();
      return json(this.publicState(pid));
    }

    if (path === "/live/answer") {
      const s = this.s;
      if (!s.players[pid]) return json({ ok: false, error: "not joined" }, 403);
      s.players[pid].lastSeen = this.now();

      // 只有作答階段、當前回合、還沒答過的才算。
      // 少了回合檢查的話，延遲的封包會把上一題的答案記到這一題頭上。
      if (s.phase !== "play") return json({ ok: false, error: "not answering" }, 409);
      if (Number(body.roundNo) !== s.roundNo) return json({ ok: false, error: "stale round" }, 409);
      if (s.answers[pid]) return json({ ok: false, error: "already answered" }, 409);

      const pos = Math.floor(Number(body.pos));
      if (!(pos >= 0 && pos <= 3)) return json({ ok: false, error: "bad option" }, 400);

      // 用時間來算速度，不採信前端送的秒數
      const ms = this.now() - s.phaseStartedAt;
      s.answers[pid] = { pos, ms, correct: pos === s.q.answerPos };
      await this.save();
      // 作答當下不回傳對錯，不然按一下就知道答案，等揭曉才公布
      return json({ ok: true, recorded: true });
    }

    if (path === "/live/leave") {
      delete this.s.players[pid];
      delete this.s.answers[pid];
      await this.save();
      return json({ ok: true });
    }

    return json({ ok: false, error: "not found" }, 404);
  }
}
