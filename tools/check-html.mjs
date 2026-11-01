/* index.html 的主程式語法檢查，外加幾個容易漏掉的對位檢查。 */
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const s = await readFile("index.html", "utf8");
let 失敗 = 0;
const 檢 = (t, c, 附) => { if (!c) 失敗++; console.log((c ? "  ✔ " : "  ✘ ") + t + (附 ? "  （" + 附 + "）" : "")); };

/* 主程式是 </body> 前面那一塊。要從最後一個 <script> 往後切，
   不能用非貪婪比對 —— 那會從第一個 <script> 一路吃到最後一個 </script>，
   中間所有的標籤都被當成程式碼，然後報一個看起來像真的語法錯誤。 */
const 結尾 = s.lastIndexOf("</script>");
const 開頭 = s.lastIndexOf("<script>", 結尾);
const m = 開頭 >= 0 ? [null, s.slice(開頭 + "<script>".length, 結尾)] : null;
檢("找得到主程式區塊", !!m);
if (m) {
  try { new vm.Script(m[1]); 檢("主程式語法正確", true); }
  catch (e) { 檢("主程式語法正確", false, String(e.message)); }
}

// 每個 getElementById 都要有對應的 id
const 用到的 = [...s.matchAll(/getElementById\('([^']+)'\)/g)].map((x) => x[1]);
const 有的 = new Set([...s.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]));
const 缺的 = [...new Set(用到的)].filter((id) => !有的.has(id));
檢("每個 getElementById 都有對應的元素", 缺的.length === 0, 缺的.length ? "缺：" + 缺的.join(", ") : 用到的.length + " 處");

// 新畫面要被 .screen 的切換機制認得
for (const id of ["screen-friends", "screen-friend-profile"]) {
  檢(id + " 是一個 .screen", new RegExp('<section id="' + id + '" class="screen"').test(s));
}

// 用到的 class 要真的有樣式
const 要有樣式 = ["fr-card", "fr-btn", "fr-search", "fr-section", "fr-empty", "fr-state", "fr-acts", "fr-hint", "nav-badge"];
const 沒樣式 = 要有樣式.filter((c) => !new RegExp("\\." + c + "[\\s{:,.]").test(s));
檢("好友用到的 class 都有樣式", 沒樣式.length === 0, 沒樣式.length ? "缺：" + 沒樣式.join(", ") : "");

// 主畫面的四個入口
const nav = s.slice(s.indexOf('<div class="home-nav">'), s.indexOf("</div>", s.indexOf('<div class="home-nav">') + 2000));
檢("主畫面有四個入口", (s.match(/<button class="neon-(pink|cyan)[^"]*" id="go-[a-z-]+btn[0-9]?"/g) || []).length >= 4,
  (s.match(/id="go-[a-z0-9-]+btn[0-9]?"/g) || []).join(" "));
檢("好友入口的格線是四欄", /\.home-nav\{ grid-template-columns:repeat\(4,1fr\); \}/.test(s));

console.log("");
console.log(失敗 ? "有 " + 失敗 + " 項沒過" : "全部通過");
process.exitCode = 失敗 ? 1 : 0;
