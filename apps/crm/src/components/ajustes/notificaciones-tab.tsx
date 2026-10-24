"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, ErrorNote } from "@/components/whatsapp/shared";

/**
 * Notificaciones push en el navegador y en el teléfono.
 *
 * El permiso lo concede el usuario por dispositivo, así que esto se activa una
 * vez en cada equipo desde el que se quiera recibir avisos.
 */

// El navegador espera la clave VAPID como bytes, no como el base64url que
// devuelve el servidor.
function claveABytes(base64url: string) {
  const relleno = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + relleno).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type Estado = "cargando" | "no-soportado" | "sin-configurar" | "bloqueado" | "activo" | "inactivo";

export function NotificacionesTab() {
  const [estado, setEstado] = useState<Estado>("cargando");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [esStandalone, setEsStandalone] = useState(false);
  const [esIOS, setEsIOS] = useState(false);

  const revisar = useCallback(async () => {
    if (typeof window === "undefined") return;

    const ua = navigator.userAgent;
    setEsIOS(/iPad|iPhone|iPod/.test(ua));
    setEsStandalone(window.matchMedia("(display-mode: standalone)").matches);

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return setEstado("no-soportado");
    }
    const r = await fetch("/api/push").then((x) => x.json());
    if (!r.disponible) return setEstado("sin-configurar");
    if (Notification.permission === "denied") return setEstado("bloqueado");

    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    setEstado(sub ? "activo" : "inactivo");
  }, []);

  useEffect(() => {
    revisar().catch((e) => setError((e as Error).message));
  }, [revisar]);

  async function activar() {
    setOcupado(true);
    setError(null);
    try {
      const permiso = await Notification.requestPermission();
      if (permiso !== "granted") {
        setEstado(permiso === "denied" ? "bloqueado" : "inactivo");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const { clave } = await fetch("/api/push").then((r) => r.json());
      const sub = await reg.pushManager.subscribe({
        // Obligatorio en todos los navegadores actuales: no se admiten pushes
        // silenciosos, cada uno tiene que mostrar una notificación.
        userVisibleOnly: true,
        applicationServerKey: claveABytes(clave),
      });

      await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });
      setEstado("activo");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  async function desactivar() {
    setOcupado(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setEstado("inactivo");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <Panel title="Notificaciones en este dispositivo">
        <p className="mb-4 text-sm text-fg-muted">
          Avisan cuando entra un mensaje en un chat que atiende una persona, y cuando
          la IA escala un chat a humano. No avisan de lo que el bot ya respondió: eso
          sería ruido y acabarías silenciándolas.
        </p>

        {estado === "cargando" && <p className="text-sm text-fg-subtle">Comprobando…</p>}

        {estado === "no-soportado" && (
          <p className="text-sm text-warning">
            Este navegador no admite notificaciones push.
          </p>
        )}

        {estado === "sin-configurar" && (
          <p className="text-sm text-warning">
            Faltan las claves VAPID en el servidor. Genera un par y ponlas en el{" "}
            <code className="font-mono text-xs">.env</code> como{" "}
            <code className="font-mono text-xs">VAPID_PUBLIC_KEY</code> y{" "}
            <code className="font-mono text-xs">VAPID_PRIVATE_KEY</code>.
          </p>
        )}

        {estado === "bloqueado" && (
          <p className="text-sm text-danger">
            Las notificaciones están bloqueadas para este sitio. Hay que permitirlas
            desde los ajustes del navegador — desde aquí ya no se puede volver a pedir.
          </p>
        )}

        {estado === "inactivo" && (
          <Button onClick={activar} disabled={ocupado}>
            <Bell className="mr-1.5 h-3.5 w-3.5" />
            {ocupado ? "Activando…" : "Activar notificaciones"}
          </Button>
        )}

        {estado === "activo" && (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-sm text-success">
              <Bell className="h-4 w-4" /> Activas en este dispositivo
            </span>
            <Button variant="ghost" size="sm" onClick={desactivar} disabled={ocupado}>
              <BellOff className="mr-1.5 h-3.5 w-3.5" /> Desactivar
            </Button>
          </div>
        )}

        <ErrorNote msg={error} />
      </Panel>

      {esIOS && !esStandalone && (
        <Panel title="En iPhone hay un paso extra">
          <div className="flex gap-3">
            <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />
            <p className="text-sm text-fg-muted">
              Safari solo entrega notificaciones si la app está añadida a la pantalla
              de inicio. Abre el menú <strong className="text-fg">Compartir</strong> y
              elige <strong className="text-fg">Añadir a pantalla de inicio</strong>;
              después entra desde ese icono y activa las notificaciones aquí. En
              Android no hace falta.
            </p>
          </div>
        </Panel>
      )}
    </>
  );
}
