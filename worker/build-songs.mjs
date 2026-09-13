/* 由根目錄的 songs.js 產生 Worker 端可以 import 的版本。

   為什麼要多這一步：瀏覽器載入 songs.js 是當成 classic script，裡面不能有 export；
   Worker 是 ESM，沒有 export 就 import 不到。與其維護兩份歌庫等著它們慢慢長歪，
   不如認定 songs.js 是唯一來源，需要的時候自動產生另一份。

   用法：npm run songs（或直接 npm run deploy，部署前會自動跑這支）
*/

import { readFile, writeFile } from "node:fs/promises";

const SRC = new URL("../songs.js", import.meta.url);
const OUT = new URL("./songs.gen.js", import.meta.url);

const src = await readFile(SRC, "utf8");

// 格式擋一下。songs.js 哪天被改成別的寫法時，要當場停下來報錯，
// 而不是產生一個 import 得到 undefined 的檔案，然後到線上才發現沒歌可出。
if (!/const\s+SONGS\s*=\s*\[/.test(src)) {
  console.error("✘ songs.js 裡找不到 `const SONGS = [`，格式可能變了，請檢查。");
  process.exit(1);
}

const count = (src.match(/\{\s*id:/g) || []).length;
if (count === 0) {
  console.error("✘ songs.js 裡一首歌都沒有，不產生檔案。");
  process.exit(1);
}

const banner =
  "/* 這個檔案是自動產生的，不要手動修改 —— 每次部署都會被覆蓋。\n" +
  "   來源：../songs.js　重新產生：npm run songs\n" +
  "*/\n\n";

await writeFile(OUT, banner + src + "\nexport { SONGS };\n", "utf8");
console.log(`✔ songs.gen.js 已更新（${count} 首）`);
