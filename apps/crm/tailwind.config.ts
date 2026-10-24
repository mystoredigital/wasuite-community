import type { Config } from "tailwindcss";

/**
 * Tokens del sistema de diseño. Los colores se definen como variables CSS en
 * globals.css (canal HSL) para poder tener tema claro/oscuro sin duplicar clases.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "hsl(var(--bg) / <alpha-value>)",
          subtle: "hsl(var(--bg-subtle) / <alpha-value>)",
          panel: "hsl(var(--bg-panel) / <alpha-value>)",
          elevated: "hsl(var(--bg-elevated) / <alpha-value>)",
        },
        border: {
          DEFAULT: "hsl(var(--border) / <alpha-value>)",
          soft: "hsl(var(--border-soft) / <alpha-value>)",
        },
        fg: {
          DEFAULT: "hsl(var(--fg) / <alpha-value>)",
          muted: "hsl(var(--fg-muted) / <alpha-value>)",
          subtle: "hsl(var(--fg-subtle) / <alpha-value>)",
        },
        // `accent` es el color del TEXTO y los bordes de acento; `accent-solid` es
        // el del relleno. En claro no pueden ser el mismo: el naranja de marca
        // relleno queda perfecto con texto oscuro encima, pero como texto sobre
        // papel da 2,3:1 y no se lee.
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          fg: "hsl(var(--accent-fg) / <alpha-value>)",
          soft: "hsl(var(--accent-soft) / <alpha-value>)",
          solid: "hsl(var(--accent-solid) / <alpha-value>)",
          "solid-fg": "hsl(var(--accent-solid-fg) / <alpha-value>)",
        },
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        danger: "hsl(var(--danger) / <alpha-value>)",
      },
      borderRadius: {
        lg: "12px",
        md: "9px",
        sm: "6px",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.07), 0 2px 8px rgba(0,0,0,0.06)",
        lift: "0 8px 24px rgba(0,0,0,0.13)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
