// Migración de arranque para producción. Se ejecuta antes del server (ver Dockerfile).
// ESM plano — no usa tsx, porque la imagen standalone no lo trae. Reutiliza los
// módulos ya copiados a la imagen (drizzle-orm, postgres) y la carpeta ./drizzle.
//
// Además del schema, garantiza que existan las etapas por defecto del pipeline
// (sin ellas la ingesta falla y el tablero sale vacío). NO carga datos demo.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL no está definida");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client);

// Reintenta: en el primer arranque el Postgres puede tardar un pelín en aceptar.
let ready = false;
for (let i = 0; i < 20 && !ready; i++) {
  try {
    await client`select 1`;
    ready = true;
  } catch {
    console.log(`[migrate] esperando a Postgres… (${i + 1})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
if (!ready) {
  console.error("[migrate] Postgres no respondió a tiempo");
  process.exit(1);
}

await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[migrate] migraciones aplicadas");

// Etapas por defecto si el pipeline está vacío.
const [{ count }] = await client`select count(*)::int as count from pipeline_stage`;
if (count === 0) {
  const STAGES = [
    ["Nuevo", "slate", "open", 0],
    ["Contactado", "blue", "open", 1],
    ["Propuesta", "violet", "open", 2],
    ["Negociación", "amber", "open", 3],
    ["Ganado", "emerald", "won", 4],
    ["Perdido", "rose", "lost", 5],
  ];
  for (const [name, color, kind, position] of STAGES) {
    const id = `stage_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    await client`
      insert into pipeline_stage (id, name, color, kind, position)
      values (${id}, ${name}, ${color}, ${kind}, ${position})
    `;
  }
  console.log("[migrate] 6 etapas por defecto creadas");
} else {
  console.log(`[migrate] el pipeline ya tiene ${count} etapas, no se toca`);
}

// Datos de ejemplo para la instancia de demostración pública. Solo con
// DEMO_SEED=true y solo si la base está vacía: en una instalación de cliente esto
// nunca se ejecuta, y si alguien la pone por error tampoco pisa datos reales.
if (process.env.DEMO_SEED === "true") {
  const [{ n }] = await client`select count(*)::int as n from contact`;
  if (n > 0) {
    console.log(`[demo] ya hay ${n} contactos, no se siembra`);
  } else {
    const [primera] = await client`select id from pipeline_stage order by position asc limit 1`;
    const [contactada] = await client`select id from pipeline_stage where position = 1 limit 1`;

    const id = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    // ISO en vez de Date: postgres-js crudo (sin el mapeo de tipos que pone
    // drizzle) no serializa objetos Date y falla con ERR_INVALID_ARG_TYPE.
    const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

    // Conversaciones creíbles: lo que de verdad se ve en un negocio, con la IA
    // respondiendo y un caso escalado a humano.
    const GENTE = [
      {
        nombre: "María González", tel: "+593991234567", etapa: 0, modo: "ai",
        chat: [
          ["user", "Buenas, vi el catálogo en Instagram. ¿Hacen envíos a Cuenca?", 240],
          ["assistant", "¡Hola María! Sí, enviamos a todo el país. A Cuenca llega en 24 a 48 horas.", 239],
          ["user", "Perfecto. ¿Y el pago cómo sería?", 235],
          ["assistant", "Puedes pagar por transferencia o contra entrega, lo que te quede mejor.", 234],
        ],
      },
      {
        nombre: "Carlos Ramírez", tel: "+593987654321", etapa: 1, modo: "human",
        handoff: "cliente",
        chat: [
          ["user", "Necesito cotizar 200 unidades para mi ferretería", 95],
          ["assistant", "Con gusto. ¿Qué referencia necesitas y para qué fecha?", 94],
          ["user", "Prefiero hablar con una persona, es un pedido grande", 92],
          ["assistant", "Claro, un compañero del equipo te atiende enseguida.", 91],
          ["operator", "Buenas Carlos, soy Andrés. Cuéntame qué necesitas y te armo la cotización hoy mismo.", 88],
        ],
      },
      {
        nombre: "Ana Torres", tel: "+593965551212", etapa: 0, modo: "ai",
        chat: [
          ["user", "Hola, ¿tienen atención los domingos?", 30],
          ["assistant", "Hola Ana. Los domingos no abrimos, pero por aquí te respondo de lunes a sábado de 8 a 6.", 29],
          ["user", "Listo, gracias!", 27],
        ],
      },
      {
        nombre: "Luis Andrade", tel: "+593998887766", etapa: 1, modo: "ai",
        chat: [
          ["user", "Quiero automatizar la atención de mi distribuidora", 12],
          ["assistant", "Justo para eso sirve esto. ¿Cuántos mensajes reciben al día, más o menos?", 11],
          ["user", "Unos 150 diarios entre pedidos y consultas", 8],
        ],
      },
    ];

    await client.begin(async (tx) => {
    for (const g of GENTE) {
      const cid = id("contact");
      const jid = `${g.tel.replace(/\D/g, "")}@s.whatsapp.net`;
      await tx`
        insert into contact (id, name, phone, wa_jid, source)
        values (${cid}, ${g.nombre}, ${g.tel}, ${jid}, 'whatsapp')`;

      // Con varios null sueltos en el VALUES, postgres-js no infiere el tipo y
      // revienta con ERR_INVALID_ARG_TYPE. El helper de objeto sí los maneja.
      await tx`insert into wa_chat ${tx({
        wa_jid: jid,
        contact_id: cid,
        is_group: false,
        mode: g.modo,
        handoff_at: g.modo === "human" ? hace(92) : null,
        handoff_reason: g.handoff ?? null,
        updated_at: hace(g.chat[g.chat.length - 1][2]),
      })}`;

      const etapa = g.etapa === 0 ? primera.id : (contactada?.id ?? primera.id);
      const [{ pos }] = await tx`select count(*)::int as pos from lead where stage_id = ${etapa}`;
      await tx`
        insert into lead (id, contact_id, stage_id, position, last_activity_at)
        values (${id("lead")}, ${cid}, ${etapa}, ${pos}, ${hace(g.chat[g.chat.length - 1][2])})`;

      for (const [rol, texto, min] of g.chat) {
        await tx`insert into message ${tx({
          id: id("msg"),
          contact_id: cid,
          wa_jid: jid,
          role: rol,
          text: texto,
          number_id: "default",
          ts: hace(min),
          read_at: rol === "user" ? hace(min) : null,
        })}`;
      }
    }
    });
    console.log(`[demo] ${GENTE.length} conversaciones de ejemplo sembradas`);
  }
}

await client.end();
