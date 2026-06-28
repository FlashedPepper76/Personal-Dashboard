// Minimal service worker — its only job is turning a push payload from
// /api/extract-todos (see sendUrgentPushNotifications) into an actual
// notification, and handling a tap on it.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'Command Deck', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Command Deck';
  const body = data.body || '';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png'
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
