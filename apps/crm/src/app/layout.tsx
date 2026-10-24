import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

// themeColor va en viewport, no en metadata: Next 15 avisa si se pone allí.
export const viewport = {
  themeColor: "#fdfcfa",
};

export const metadata: Metadata = {
  title: "Wa Suite",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Wa Suite", statusBarStyle: "default" },
  description: "CRM de WhatsApp con IA, en tu propio servidor: bandeja, pipeline y agente. Tus datos no salen de ahí.",
};

// Aplica el tema guardado ANTES de pintar. Si esto se hiciera desde React, la
// primera pintura saldría en claro y el que eligió oscuro vería un destello
// blanco en cada carga.
const TEMA = `try{var t=localStorage.getItem('wasuite-tema');if(t==='dark'){var e=document.documentElement;e.classList.remove('light');e.classList.add('dark')}}catch(e){}`;

// El shell (nav lateral) vive en (app)/layout.tsx, no aquí, para que /login se
// renderice a pantalla completa sin la barra.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`light ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: TEMA }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
