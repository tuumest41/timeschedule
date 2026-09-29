/*
 * Service Worker（オフライン対応とキャッシュ更新）
 *
 * ★アプリを更新したら、下の VERSION の数字を1つ上げてください。
 *   → iPhone側で新しい版が自動で入り、古いキャッシュは削除され、画面が読み込み直されます。
 *
 * 取得方法は「ネットワーク優先」：
 *   オンラインなら常にサーバーの最新ファイルを使い、キャッシュも最新に書き換える。
 *   オフライン（または通信が遅い）ときだけキャッシュを使う。
 */
const VERSION = 'v1';
const CACHE = 'ts-cache-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())   // 待たずにすぐ新しい版へ
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ts-cache-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// リダイレクトされた応答は Safari で表示できないことがあるので作り直す
async function cleanResponse(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isPage = req.mode === 'navigate';

  const network = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    .then(cleanResponse)
    .then(async (res) => {
      if (res.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(isPage ? './index.html' : req, res.clone());
      }
      return res;
    });

  event.waitUntil(network.catch(() => {}));

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = isPage
      ? (await cache.match('./index.html')) || (await cache.match('./'))
      : await cache.match(req, { ignoreSearch: true });
    if (!cached) return network;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
    return Promise.race([network.catch(() => cached), timeout]);
  })());
});
