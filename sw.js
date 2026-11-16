// オフラインでも開けるようにするためのサービスワーカー（インターネット上に置いた版でだけ登録する）。
// 方針は「まずネットワーク（毎回最新を確認）、だめならキャッシュ」。つながっている間は常に最新の
// ファイルを使うので、更新が反映されないという事故が起きない。電波がないときは、最後に開いたときのファイルで起動する。
// Google との通信（別のサイト宛て）には一切関わらない。

const CACHE = 'planner-shell-v2';

/**
 * サーバーに「変わっていないか」を毎回たずねて取得する。
 * 置き場所（GitHub Pages）はファイルを 10 分間キャッシュさせるので、そのままだと更新直後に
 * 新旧のファイルが混ざる。変わっていなければ中身は送られてこないので、通信量はほぼ増えない。
 */
async function fetchFresh(req) {
  if (req.mode !== 'navigate') return fetch(req, { cache: 'no-cache' });
  // ページの読み込みは同じ形で作り直せないので、URL から取り直す
  const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  return res.redirected ? fetch(req) : res;
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  event.respondWith(
    fetchFresh(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        // ログインの戻りなどで付いた ? や # は無視して探す
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await caches.match(new URL('./', self.location).href);
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
