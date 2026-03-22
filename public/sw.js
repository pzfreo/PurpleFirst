// Service worker for Web Share Target support
// Intercepts shared images and passes them to the app

const CACHE_NAME = 'share-target-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept POST to the share-target endpoint
  if (url.pathname.endsWith('/share-target') && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // Let all other requests pass through to the network (no offline caching)
  return;
});

async function handleShareTarget(request) {
  const formData = await request.formData();
  const file = formData.get('image');

  if (file) {
    // Store the shared file in a cache so the app can retrieve it
    const cache = await caches.open(CACHE_NAME);
    await cache.put('/shared-image', new Response(file, {
      headers: { 'Content-Type': file.type }
    }));
  }

  // Redirect to the app with a query param so it knows to check for shared content
  const appUrl = new URL('/PurpleFirst/', self.location.origin);
  appUrl.searchParams.set('shared', '1');
  return Response.redirect(appUrl.toString(), 303);
}
