import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Combina clases de Tailwind resolviendo conflictos (la última gana).
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Iniciales para el avatar: "Juan Pérez" → "JP".
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Matiz estable para el avatar de un contacto: el mismo nombre da siempre el
// mismo color. Ocho tonos repartidos por la rueda, ninguno cerca del oro de la
// marca (~38°) para que un avatar no se confunda con un no leído. La
// luminosidad no va aquí: la ponen --av-bg-l / --av-fg-l según el tema.
const MATICES_AVATAR = [4, 96, 140, 172, 199, 232, 268, 320];

export function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  return MATICES_AVATAR[h % MATICES_AVATAR.length];
}

// Centavos → texto de moneda. Sin decimales si es redondo.
export function formatMoney(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  const value = cents / 100;
  return new Intl.NumberFormat("es-EC", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

// Fecha relativa corta en español ("hace 3 días", "hace 2 h", "ahora").
export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "ahora";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days} d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `hace ${months} mes${months > 1 ? "es" : ""}`;
  return `hace ${Math.floor(months / 12)} a`;
}
