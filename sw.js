const CACHE_NAME = "phraseofun-pwa-v4";

// Все локальные файлы которые нужны для офлайн-работы
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data.js",
  "./contentService.js",
  "./supabaseClient.js",
  "./supabaseConfig.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
];

// Установка — кэшируем по одному, чтобы одна ошибка не блокировала всё
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(
        PRECACHE.map((url) =>
          cache.add(url).catch((e) =>
            console.warn("[SW] не удалось закэшировать:", url, e)
          )
        )
      );
      // Активируемся сразу, не ждём закрытия старых вкладок
      self.skipWaiting();
    })()
  );
});

// Активация — удаляем старые кэши
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null))
      );
      self.clients.claim();
    })()
  );
});

// Fetch — стратегия: сначала сеть, при ошибке кэш (Network-first)
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Только GET
  if (req.method !== "GET") return;

  // Supabase и CDN — не кэшируем через SW (у них CORS + динамика)
  if (
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("jsdelivr.net") ||
    url.hostname.includes("cdn.")
  ) {
    return; // браузер сам обработает
  }

  // Навигация (HTML-страница)
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cached = await cache.match("./index.html");
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // Локальные статичные файлы — Cache-first (быстро + офлайн)
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        if (cached) {
          // Обновить в фоне (stale-while-revalidate)
          fetch(req)
            .then((fresh) => {
              if (fresh && fresh.ok) cache.put(req, fresh.clone());
            })
            .catch(() => { });
          return cached;
        }
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch {
          return Response.error();
        }
      })()
    );
  }
});