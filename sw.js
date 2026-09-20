/* 音隙偵探 — Service Worker
   存在的目的只有兩個：
   1. 讓瀏覽器認定這是可安裝的 PWA（Chrome 要求必須有 fetch 事件處理）
   2. 完全離線時給一個能開起來的畫面

   刻意採用「網路優先」：這個遊戲的歌都靠 YouTube 串流，離線本來就玩不了，
   所以沒必要為了離線去快取內容。更重要的是，快取優先會讓我 push 更新後
   使用者還看到舊版本 —— 那會毀掉「改完重新整理就生效」這個最大優點。
*/

// 換版本號會讓 activate 把舊的整個刪掉 —— 之前那份已經被查詢字串灌肥了
const CACHE = 'earsleuth-v3';
// 只留最低限度的殼，離線時至少開得起來
const SHELL = ['./', './index.html', './songs.js', './manifest.json', './icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 只管自己網域的 GET；YouTube、Cloudflare Workers 的請求一律不要插手
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // version.json 絕對不能經手。它存在的意義就是讓頁面判斷自己是不是舊版，
  // 一旦被快取住就會回報「你已經是最新的」，這個機制反而變成幫兇。
  if (new URL(req.url).pathname.endsWith('/version.json')) return;

  // 快取一律用「去掉查詢字串」的網址當 key。用完整網址的話，
  // index.html?t=1、?t=2、?r=3 會各自存成一份完整頁面 ——
  // 實測開幾次就堆了八份，而且會一直長大直到把使用者的儲存空間吃完。
  const cacheKey = new URL(req.url).origin + new URL(req.url).pathname;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 順手把最新版本存起來，純粹當離線時的後備
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(cacheKey, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(cacheKey).then((hit) => hit || caches.match('./index.html'))
      )
  );
});
