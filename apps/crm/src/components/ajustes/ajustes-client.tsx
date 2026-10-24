"use client";

import { useState } from "react";
import { KeyRound, Webhook, Users, Gauge, ScrollText, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { ClavesTab } from "@/components/whatsapp/claves-tab";
import { ConsumoTab } from "@/components/whatsapp/consumo-tab";
import { WebhooksTab } from "./webhooks-tab";
import { UsuariosTab } from "./usuarios-tab";
import { AuditoriaTab } from "./auditoria-tab";
import { NotificacionesTab } from "./notificaciones-tab";

/**
 * Ajustes de la suite.
 *
 * Existe para que la configuración que no es del bot deje de vivir en el
 * dashboard del agente, en otro dominio. La sección WhatsApp se queda con lo que
 * define cómo responde el bot (conexión, prompt, conocimiento, laboratorio,
 * grupos); aquí va lo transversal: acceso, integraciones y consumo.
 */

type Tab = "claves" | "webhooks" | "notificaciones" | "usuarios" | "consumo" | "auditoria";

const TABS: Array<{ key: Tab; label: string; icon: typeof KeyRound }> = [
  { key: "claves", label: "Claves API", icon: KeyRound },
  { key: "webhooks", label: "Webhooks", icon: Webhook },
  { key: "notificaciones", label: "Notificaciones", icon: Bell },
  { key: "usuarios", label: "Usuarios", icon: Users },
  { key: "consumo", label: "Consumo", icon: Gauge },
  { key: "auditoria", label: "Auditoría", icon: ScrollText },
];

export function AjustesClient() {
  const [tab, setTab] = useState<Tab>("claves");

  return (
    <div className="flex h-[calc(100vh-3.5rem)] md:h-screen flex-col">
      <PageHeader title="Ajustes" subtitle="Acceso, integraciones y consumo" />

      <div className="flex gap-1 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] md:px-6 [&::-webkit-scrollbar]:hidden">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
              tab === key
                ? "border-accent text-fg"
                : "border-transparent text-fg-subtle hover:text-fg-muted",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === "claves" && <ClavesTab />}
        {tab === "webhooks" && <WebhooksTab />}
        {tab === "notificaciones" && <NotificacionesTab />}
        {tab === "usuarios" && <UsuariosTab />}
        {tab === "consumo" && <ConsumoTab />}
        {tab === "auditoria" && <AuditoriaTab />}
      </div>
    </div>
  );
}
