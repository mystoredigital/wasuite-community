// Paleta de acentos por etapa. La clave se guarda en pipeline_stage.color y aquí se
// traduce a clases de Tailwind, para no meter color arbitrario en la base de datos.
// Las CLAVES no cambian (viven en pipeline_stage.color); las clases mapean a la
// versión cálida de cada familia: stone en vez de slate, teal en vez de sky.
export const STAGE_COLORS: Record<string, { dot: string; bar: string; ring: string }> = {
  slate: { dot: "bg-stone-400", bar: "bg-stone-400/60", ring: "ring-stone-400/30" },
  blue: { dot: "bg-teal-400", bar: "bg-teal-400/60", ring: "ring-teal-400/30" },
  violet: { dot: "bg-orange-400", bar: "bg-orange-400/60", ring: "ring-orange-400/30" },
  amber: { dot: "bg-amber-400", bar: "bg-amber-400/60", ring: "ring-amber-400/30" },
  emerald: { dot: "bg-emerald-400", bar: "bg-emerald-400/60", ring: "ring-emerald-400/30" },
  rose: { dot: "bg-rose-400", bar: "bg-rose-400/60", ring: "ring-rose-400/30" },
};

export const STAGE_COLOR_KEYS = Object.keys(STAGE_COLORS);

export function stageColor(key: string) {
  return STAGE_COLORS[key] ?? STAGE_COLORS.slate;
}
