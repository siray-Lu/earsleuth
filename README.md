# 音隙偵探

聽一小段就猜出歌名。收錄 699 首華語經典金曲，分成懷舊金曲（70~90 年代）與千禧新聲（2000 年後）。

🎮 **線上遊玩：** https://siray-lu.github.io/Sound_Gap_Detective/

## 玩法

| 模式 | 內容 |
|---|---|
| 單人挑戰 | 簡單 / 困難 / 魔王三種難度，片段從 10 秒縮到 5 秒 |
| 計時挑戰 | 比誰最快答對指定題數，成績上全站排行榜 |
| ⚡ 全場競速 | 不用揪人，全站同一個場次連續跑，所有人同時聽同一題比誰先按對 |
| 🔗 連線對戰 | 開房間邀朋友，最多 8 人，附聊天室 |

全場競速一回合 15 秒：2 秒準備 → 10 秒作答（播 8 秒片段）→ 3 秒揭曉。
計分為基礎 100 分 + 速度分（最多 100）+ 連對加成（每連一題 +20，上限 400）。

## 個人檔案

第一次進來會請你取暱稱、挑頭像，成績都記在這個身分底下。系統會給一組**接回碼** ——
換手機或清掉瀏覽器資料之後，只有這串能把紀錄接回來，記得抄下來收好。

## 專案結構

```
index.html          遊戲本體（畫面、邏輯、播放控制）
songs.js            歌庫，唯一來源。要加歌改這裡就好
sw.js               Service Worker，讓它可以「加到主畫面」變成 App
worker/             Cloudflare Workers 後端
  worker.js         房間、個人檔案、排行榜、全場競速
  build-songs.mjs   由 songs.js 產生 Worker 端要的歌庫
  test-live.mjs     全場競速回合引擎的離線模擬測試
_serve.ps1          本機開發用的靜態伺服器（含房間 API）
```

前端是純靜態檔案，放 GitHub Pages 就能跑。後端用 Cloudflare Workers +
Durable Objects：房間、玩家檔案、排行榜、競速場次各自一個 DO。

## 本機開發

直接執行 `啟動遊戲.bat`，會在 http://localhost:8795 開起來。

後端要部署時：

```bash
cd worker
npm install
npx wrangler login
npm run deploy      # 會先由 songs.js 重新產生歌庫再部署
npm test            # 全場競速回合引擎的模擬測試
```

## 加新歌

只改 `songs.js`，格式照現有的來：

```js
{ id:711, title:"歌名", artist:"歌手", videoId:"YouTube影片ID", start:50, tier:"easy", era:"post90" },
```

`start` 是副歌或記憶點大約開始的秒數，難度會以它為基準往前推算播放位置。
改完跑一次 `npm run deploy`，伺服器端的歌庫會自動同步。

## 授權

個人專案。歌曲皆透過 YouTube 官方 MV 串流播放，本專案不儲存任何音訊檔案。
