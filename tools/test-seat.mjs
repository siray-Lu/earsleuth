/* 座位紀錄的三種情境。把 index.html 裡那段函式原封不動抓出來跑，
   localStorage 用一個假的物件模擬（同一個瀏覽器的分頁共用它，這正是問題的來源）。 */
import { readFile } from "node:fs/promises";

const html = await readFile(process.argv[2], "utf8");
const 起 = html.indexOf("const SEAT_ALIVE_MS");
const 迄 = html.indexOf("function mpLeaveRoom");
if (起 < 0 || 迄 < 0) { console.error("✘ 抓不到座位函式區塊"); process.exit(1); }
const 程式 = html.slice(起, 迄);

const store = new Map();   // 整個瀏覽器共用這一份
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// 做一個「分頁」：它有自己的 TAB_ID，但共用 localStorage
const 開分頁 = (tabId) =>
  new Function("localStorage", "TAB_ID",
    程式 + "; return { mpReadSeats, mpWriteSeats, mpClaimSeat, mpRememberPlayerId, mpRecallSeat, mpForgetPlayerId };"
  )(localStorage, tabId);

const 結果 = [];
const 檢查 = (名, 實際, 期望) =>
  結果.push({ 項目: 名, 實際, 期望, 通過: JSON.stringify(實際) === JSON.stringify(期望) });

const A = 開分頁("tabA");
const B = 開分頁("tabB");

// ① 房主入座
A.mpRememberPlayerId("799218", "host-1", "sec-host");
檢查("① 房主接回自己的位子", A.mpRecallSeat("799218"), { id: "host-1", secret: "sec-host" });

// ② 同瀏覽器第二個分頁加入：不該撿到房主的位子
檢查("② 新分頁拿不到別人的位子", B.mpRecallSeat("799218"), { id: null, secret: null });
B.mpRememberPlayerId("799218", "guest-1", "sec-guest");

// ③ 關鍵：客人入座後，房主的紀錄不能被蓋掉
檢查("③ 房主紀錄沒被蓋掉", A.mpRecallSeat("799218"), { id: "host-1", secret: "sec-host" });
檢查("③ 客人拿到自己的位子", B.mpRecallSeat("799218"), { id: "guest-1", secret: "sec-guest" });

// ④ 重新整理：同一個分頁識別碼，照樣接回原位
const A2 = 開分頁("tabA");
檢查("④ 重整後接回原位", A2.mpRecallSeat("799218"), { id: "host-1", secret: "sec-host" });

// ⑤ 關掉再開（新的分頁識別碼）：舊座位已經沒人更新時間，可以接回去。
//    把兩筆的 ts 都調到過期，模擬「瀏覽器整個關掉一陣子」
const list = A.mpReadSeats("799218").map((x) => ({ ...x, ts: Date.now() - 60000 }));
A.mpWriteSeats("799218", list);
const C = 開分頁("tabC");
const 撿到 = C.mpRecallSeat("799218");
檢查("⑤ 關掉再開撿得回舊位子", !!撿到.id && ["host-1", "guest-1"].includes(撿到.id), true);

// ⑥ 但只要還有分頁在輪詢（會更新 ts），那個位子就不能被撿走
A.mpClaimSeat("799218");                       // 房主還開著
const D = 開分頁("tabD");
檢查("⑥ 活著的位子不會被撿走", D.mpRecallSeat("799218").id !== "host-1", true);

// ⑦ 離開房間只清自己那筆
B.mpForgetPlayerId("799218");
檢查("⑦ 客人離開後房主還在", A.mpRecallSeat("799218").id, "host-1");
檢查("⑦ 客人自己的位子清掉了", B.mpReadSeats("799218").some(x=>x.tab==="tabB"), false);

// ⑧ 舊格式（單一物件）要讀得懂
store.set("mp-pid-111111", JSON.stringify({ id: "old-1", secret: "old-sec" }));
檢查("⑧ 讀得懂舊格式", 開分頁("tabE").mpRecallSeat("111111"), { id: "old-1", secret: "old-sec" });

// ⑨ 更早的純字串格式
store.set("mp-pid-222222", "plain-id");
檢查("⑨ 讀得懂純字串舊格式", 開分頁("tabF").mpRecallSeat("222222"), { id: "plain-id", secret: null });

const 失敗 = 結果.filter((r) => !r.通過);
結果.forEach((r) => console.log((r.通過 ? "✅ " : "❌ ") + r.項目 +
  (r.通過 ? "" : `\n      實際 ${JSON.stringify(r.實際)}\n      期望 ${JSON.stringify(r.期望)}`)));
console.log(`\n${結果.length - 失敗.length} / ${結果.length} 通過`);
process.exit(失敗.length ? 1 : 0);
