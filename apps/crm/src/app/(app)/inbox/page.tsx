import { InboxClient } from "@/components/inbox/inbox-client";

export const dynamic = "force-dynamic";

export default function InboxPage() {
  // El dashboard público del agente (para el QR), si está configurado. Se lee en el
  // server a request-time y se pasa como prop, así no necesita ser NEXT_PUBLIC.
  const agentDashboard = process.env.AGENT_DASHBOARD_URL ?? null;
  // En la instancia de demostración no hay WhatsApp vinculado, y el aviso de
  // "no conectado" sobra: no es un fallo, es cómo está montada.
  const demo = process.env.DEMO_SEED === "true";
  return <InboxClient agentDashboard={demo ? null : agentDashboard} demoMode={demo} />;
}
