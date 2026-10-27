// KILL SWITCH (10/27): any laptop still holding the root desk helper drops it; no fetch handler = straight to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => { e.waitUntil((async () => { try { await self.registration.unregister(); } catch (x) {} try { (await self.clients.matchAll({ type: 'window' })).forEach((c) => c.navigate(c.url)); } catch (x) {} })()); });
