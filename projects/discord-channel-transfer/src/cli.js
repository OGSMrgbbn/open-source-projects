import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { exportGuild, validateManifest } from './archive.js';
import { importGuild } from './transfer.js';
import { readJson, lockDirectory, snowflake } from './storage.js';

const cyan = text => process.stdout.isTTY ? `\x1b[36m${text}\x1b[0m` : text;
const log = text => console.log(`${cyan(new Date().toLocaleTimeString('de-DE'))}  ${text}`);
const HELP = `
CHANNEL TRANSFER · Raspberry Pi / Node.js

npm start                         Interaktives Konsolenmenü
npm start -- servers               Server anzeigen
npm start -- export --source ID --archive data/mein-backup
npm start -- inspect --archive data/mein-backup
npm start -- import --target ID --archive data/mein-backup
npm start -- import --target ID --archive data/mein-backup --apply

Optionen:
  --max-messages ZAHL      Neueste N je Channel; 0 = alle (Standard)
  --max-attachment-mb N    Downloadlimit je Datei; Standard 10 MiB
  --apply                 Import tatsächlich ausführen; sonst Vorschau
  --retry-uncertain       Unklaren API-Aufruf erneut ausführen, erst Ziel prüfen
  --help                  Hilfe

DISCORD_TOKEN lokal in .env setzen. Selfbots verstoßen gegen Discord-Regeln.
Ctrl+C stoppt nach dem laufenden Arbeitsschritt; gleicher Befehl setzt fort.
`;

function positiveNumber(value, fallback, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new Error(`Ungültige Zahl: ${value}`);
  return number;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: 'string' }, target: { type: 'string' }, archive: { type: 'string' },
    'max-messages': { type: 'string' }, 'max-attachment-mb': { type: 'string' },
    apply: { type: 'boolean' }, 'retry-uncertain': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(HELP); return; }
  let command = positionals[0];
  if (positionals.length > 1 || (command && !['servers', 'export', 'inspect', 'import'].includes(command))) throw new Error('Unbekannter Befehl. Hilfe: npm start -- --help');
  if (command === 'inspect') {
    if (!values.archive) throw new Error('--archive fehlt.');
    const manifest = validateManifest(await readJson(path.resolve(values.archive, 'manifest.json')));
    console.log(JSON.stringify({ source: manifest.source, createdAt: manifest.createdAt, channels: manifest.channels.map(c => ({ name: c.name, type: c.type, messages: manifest.histories[c.id]?.count ?? 0 })), warnings: manifest.warnings }, null, 2));
    return;
  }
  let rl;
  let client;
  let stop = false;
  const onSignal = () => { stop = true; log('Stopp angefordert – laufender Schritt wird gespeichert.'); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (!command) {
      if (!process.stdin.isTTY) { console.log(HELP); return; }
      rl = createInterface({ input: process.stdin, output: process.stdout });
      console.log(cyan('\n╔════════════════════════════════════════╗\n║          CHANNEL TRANSFER              ║\n║     Export · Vorschau · Übertragen     ║\n╚════════════════════════════════════════╝\n'));
      console.log('  1  Server anzeigen\n  2  Server exportieren (inkl. Nachrichten)\n  3  Import-Vorschau\n  4  Archiv übertragen\n  0  Beenden\n');
      const choice = (await rl.question('Auswahl › ')).trim();
      if (choice === '0') return;
      command = { 1: 'servers', 2: 'export', 3: 'import', 4: 'import' }[choice];
      if (!command) throw new Error('Ungültige Auswahl.');
      values.apply = choice === '4';
    }
    if (!process.env.DISCORD_TOKEN?.trim()) throw new Error('DISCORD_TOKEN fehlt. .env.example nach .env kopieren und lokal ausfüllen.');
    const { Client, Options } = await import('discord.js-selfbot-v13');
    client = new Client({
      captchaRetryLimit: 0, retryLimit: 0, restRequestTimeout: 30_000,
      allowedMentions: { parse: [], repliedUser: false },
      makeCache: Options.cacheWithLimits({ MessageManager: 0, PresenceManager: 0 }),
    });
    client.on('error', () => log('Discord-Verbindungsfehler. Der aktuelle Schritt kann fehlschlagen.'));
    client.on('rateLimit', info => log(`Discord-Limit: warte ${Math.ceil((info.timeout ?? 1000) / 1000)} Sekunden.`));
    let timer;
    try {
      await Promise.race([
        client.login(process.env.DISCORD_TOKEN.trim()),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Discord-Anmeldung nach 60 Sekunden abgebrochen.')), 60_000); }),
      ]);
    } finally { clearTimeout(timer); }
    log(`Verbunden als ${client.user.username}`);
    const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (command === 'servers' || rl) console.table(guilds.map(g => ({ Server: g.name, ID: g.id })));
    if (command === 'servers') return;
    if (rl) {
      const idKey = command === 'export' ? 'source' : 'target';
      values[idKey] = (await rl.question(`${idKey === 'source' ? 'Quellserver' : 'Zielserver'}-ID › `)).trim();
      values.archive = (await rl.question('Archivordner [data/backup] › ')).trim() || 'data/backup';
      if (command === 'export') values['max-messages'] = (await rl.question('Nachrichten je Channel [0 = alle] › ')).trim() || '0';
    }
    const guildId = command === 'export' ? values.source : values.target;
    if (!snowflake(guildId)) throw new Error('Gültige --source bzw. --target Server-ID erforderlich.');
    if (!values.archive) throw new Error('--archive ORDNER erforderlich.');
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Dieser Server ist für das angemeldete Konto nicht verfügbar.');
    const dir = path.resolve(values.archive);
    await lockDirectory(dir, async () => {
      if (command === 'export') {
        await exportGuild(guild, await guild.members.fetchMe(), dir, {
          maxMessages: positiveNumber(values['max-messages'], 0, Number.MAX_SAFE_INTEGER),
          maxAttachmentMB: positiveNumber(values['max-attachment-mb'], 10, 1024),
          log, stopped: () => stop,
        });
      } else {
        const manifest = validateManifest(await readJson(path.join(dir, 'manifest.json')));
        await guild.channels.fetch();
        if (rl && values.apply) {
          await importGuild(manifest, dir, guild, client.user.id, { log });
          const confirm = await rl.question(`Zum Übertragen Ziel-ID ${guild.id} eingeben › `);
          if (confirm.trim() !== guild.id) { log('Abgebrochen.'); return; }
        }
        await importGuild(manifest, dir, guild, client.user.id, { apply: values.apply, retryUncertain: values['retry-uncertain'], log, stopped: () => stop });
      }
    });
  } finally {
    client?.destroy(); rl?.close();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
}

main().catch(error => {
  // Never dump request objects, headers or stacks: library errors can contain tokens.
  let message = String(error.message ?? 'Unbekannter Fehler');
  if (process.env.DISCORD_TOKEN) message = message.split(process.env.DISCORD_TOKEN).join('[TOKEN]');
  console.error(`\nFehler: ${message}`);
  process.exitCode = 1;
});
