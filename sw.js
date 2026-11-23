"use strict";
// Service worker: shows pushes, opening golemd's sealed ones with the account key (push-open.js), and opens the app on a tap. No offline cache in phase 1.
try {
  importScripts("/vendor/e2e/libsodium.js", "/vendor/e2e/libsodium-wrappers.js", "/vendor/e2e/e2e.js");
} catch {
  // Without the encryption core a sealed push still shows, as the generic note.
}
importScripts("/push-open.js");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Golemworks", body: event.data ? event.data.text() : "" };
  }
  const E = self.GolemworksE2E;
  const shown = self.GolemworksPush.openPush(data, { E, loadKeys: () => E.phoneKeyStore().load(), seen: self.GolemworksPush.seenStore() }).then((note) =>
    self.registration.showNotification(note.title, {
      body: note.body,
      tag: note.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: note.url },
    }),
  );
  event.waitUntil(shown);
});

// An open app is told where to go (a message, not a reload, so the same link twice still opens it); a closed one opens there.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only a screen of this app: the push's link keeps just its #hash, so a hub cannot open another page or site from a tap.
  const target = `/${new URL(event.notification.data?.url || "/#fleet", self.location.origin).hash || "#fleet"}`;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.postMessage({ type: "open", url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
