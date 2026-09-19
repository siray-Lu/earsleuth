/* 在 index.html 與 version.json 蓋上同一個版本戳記。

   為什麼需要這個：頁面本身會被瀏覽器快取住，使用者可能連續好幾天都在跑舊版，
   而舊版可能指向已經停用的後端 —— 畫面一切正常，成績卻全部寫進黑洞。
   前端要能自己發現「我是舊的」，唯一的辦法是把版本編進 HTML，
   再去抓一份繞過快取的 version.json 來比對。

   兩邊的值必須完全一致，所以一定要由這支腳本一起寫，不要手動改任何一邊。

   用法：node tools/stamp-version.mjs（部署前跑）
*/

import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const indexPath = new URL("index.html", root);
const versionPath = new URL("version.json", root);

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const version =
  `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
  `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;

let html = await readFile(indexPath, "utf8");
const pattern = /const APP_VERSION = '[^']*';/;

if (!pattern.test(html)) {
  console.error("✘ index.html 裡找不到 `const APP_VERSION = '...';`，版本機制可能被改壞了。");
  process.exit(1);
}

html = html.replace(pattern, `const APP_VERSION = '${version}';`);
await writeFile(indexPath, html, "utf8");
await writeFile(versionPath, JSON.stringify({ version }, null, 2) + "\n", "utf8");

console.log(`✔ 版本戳記 ${version}（index.html 與 version.json 已同步）`);
