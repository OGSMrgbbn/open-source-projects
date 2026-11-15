import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { hasPendingUpdate } from './updater.js';
import { presenceConfig, startPresence } from './presence.js';

// Deliberately independent of the transfer session and its repository lock.
// No archive operations or message sends are performed by this service.
let client, stopPresence, watchdog, loginTimeout;
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(loginTimeout); clearInterval(watchdog); stopPresence?.();
  client?.destroy();
  process.exitCode = code;
  // Bound shutdown even if a library socket refuses to close.
  setTimeout(() => process.exit(code), 2000).unref();
}
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
process.on('uncaughtException', () => { console.error('Statusdienst: interner Fehler; Neustart.'); shutdown(1); });
process.on('unhandledRejection', () => { console.error('Statusdienst: Verbindung fehlgeschlagen; Neustart.'); shutdown(1); });

async function main() {
  if (await hasPendingUpdate(process.cwd())) throw new Error('Update noch unvollständig.');
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) throw new Error('Token fehlt.');
  const config = presenceConfig();
  const { Client, Options } = await import('discord.js-selfbot-v13');
  if (stopping) return;
  client = new Client({
    captchaRetryLimit: 0, retryLimit: 0, restRequestTimeout: 30000,
    presence: { status: 'online', afk: false, activities: [] }, allowedMentions: { parse: [], repliedUser: false },
    makeCache: Options.cacheWithLimits({ MessageManager: 0, PresenceManager: 0 }),
  });
  client.on('error', () => console.error('Discord-Verbindungsfehler; Wiederverbindung läuft.'));
  client.on('invalidated', () => { console.error('Discord-Sitzung ungültig; Neustart.'); shutdown(1); });
  stopPresence = startPresence(client, config, { log: message => console.log(message) });
  loginTimeout = setTimeout(() => { console.error('Anmeldung nach 60 Sekunden abgebrochen.'); shutdown(1); }, 60000);
  await client.login(token);
  clearTimeout(loginTimeout);
  if (stopping) return;
  console.log(`Statusdienst verbunden. Textwechsel alle ${config.intervalMs / 1000} Sekunden.`);
  let lastReady = Date.now(); let checking = false;
  watchdog = setInterval(async () => {
    if (checking || stopping) return;
    checking = true;
    try {
      if (client.isReady()) lastReady = Date.now();
      else if (Date.now() - lastReady > 120000) { console.error('Verbindung seit zwei Minuten unterbrochen; Neustart.'); shutdown(1); return; }
      // Reload edited credentials/settings via a clean systemd restart, without logging them.
      const env = parseEnv(await readFile('.env', 'utf8'));
      const nextConfig = presenceConfig(env);
      if (env.DISCORD_TOKEN?.trim() !== token || JSON.stringify(nextConfig) !== JSON.stringify(config)) {
        console.log('Lokale Einstellungen geändert; Neustart.'); shutdown(1);
      }
    } catch { console.error('Lokale Einstellungen nicht lesbar oder ungültig; bisheriger Status bleibt aktiv.'); }
    finally { checking = false; }
  }, 30000);
}
main().catch(() => { console.error('Statusdienst konnte nicht starten. Lokale .env und Verbindung prüfen.'); shutdown(1); });
