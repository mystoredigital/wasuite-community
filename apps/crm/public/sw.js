/*
 * Service worker de Wa Suite.
 *
 * Hace dos cosas y a propósito ninguna más: recibir notificaciones push y abrir
 * la app al tocarlas. NO cachea nada — el inbox y el pipeline son datos vivos, y
 * una caché mal invalidada haría creer al operador que ve la conversación actual
 * cuando está viendo la de hace una hora. Eso es peor que no tener PWA.
 */

self.addEventListener("install", () => {
  // Sin esto la versión nueva espera a que se cierren todas las pestañas.
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { titulo: "Wa Suite", cuerpo: e.data ? e.data.text() : "" };
  }

  e.waitUntil(
    self.registration.showNotification(d.titulo || "Wa Suite", {
      body: d.cuerpo || "",
      icon: "/brand/isotipo-wa-avatar.svg",
      badge: "/brand/isotipo-wa-avatar.svg",
      // Agrupa por chat: diez mensajes del mismo contacto son un aviso que se
      // actualiza, no diez avisos apilados.
      tag: d.tag || "wasuite",
      renotify: true,
      data: { url: d.url || "/inbox" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || "/inbox";

  // Si ya hay una pestaña abierta se reutiliza en vez de abrir otra: nadie quiere
  // quince pestañas del CRM por haber tocado quince avisos.
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ("focus" in c) {
          c.navigate(destino);
          return c.focus();
        }
      }
      return self.clients.openWindow(destino);
    }),
  );
});
