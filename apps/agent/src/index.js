import 'dotenv/config';
import { tenants } from './tenants.js';
import { startServer } from './server.js';
import { createUser, findUser } from './users.js';

async function main() {
  // Fail-fast de configuración: sin secreto de sesión cualquiera podría forjar
  // cookies, y sin credenciales de operador el dashboard no tiene dueño. Mejor
  // negarse a arrancar con instrucciones claras que arrancar inseguro.
  if (!process.env.SESSION_SECRET && !process.env.GHL_SHARED_SECRET) {
    console.error('[fatal] SESSION_SECRET no está definido. Genera uno con:');
    console.error('        openssl rand -hex 32   (o: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")');
    process.exit(1);
  }
  await tenants.bootstrap();
  console.log('[boot] tenants cargados:', tenants.list().map((t) => t.tenantId).join(', '));

  // Usuario de la instancia de demostración pública. Se crea con rol 'client' a
  // propósito: ve la bandeja, el pipeline y los contactos, pero no puede tocar el
  // prompt, emitir claves, ni llegar a la vinculación de WhatsApp. Sin esto, una
  // demo abierta dejaría a cualquiera escanear el QR o reescribir el bot.
  if (process.env.DEMO_USER && process.env.DEMO_PASS) {
    const u = process.env.DEMO_USER;
    if (await findUser(u)) {
      console.log(`[demo] el usuario '${u}' ya existe`);
    } else {
      await createUser({
        username: u,
        password: process.env.DEMO_PASS,
        role: 'client',
        tenantId: '_local',
      }).then(() => console.log(`[demo] usuario '${u}' creado con rol client`))
        .catch((e) => console.warn('[demo] no se pudo crear el usuario:', e.message));
    }
  }
  startServer(Number(process.env.PORT) || 3000);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
