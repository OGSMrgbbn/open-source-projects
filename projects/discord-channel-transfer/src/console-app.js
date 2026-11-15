import path from 'node:path';
import { readdir, chmod } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { TerminalUI } from './terminal.js';
import { readJson, lockDirectory } from './storage.js';
import { exportGuild, validateManifest } from './archive.js';
import { importGuild, transferPlan } from './transfer.js';
import { buildPresence, presenceConfig } from './presence.js';

const errorText = error => {
  let text = String(error.message ?? error);
  if (process.env.DISCORD_TOKEN) text = text.split(process.env.DISCORD_TOKEN).join('[TOKEN]');
  return text;
};

export async function listArchives(root = 'data') {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const archives = [];
  for (const entry of entries.filter(e => e.isDirectory())) {
    const dir = path.resolve(root, entry.name);
    try {
      const manifest = await readJson(path.join(dir, 'manifest.json'));
      if (manifest.version !== 1 || !manifest.source?.id) continue;
      archives.push({ dir, name: entry.name, manifest, count: Object.values(manifest.histories ?? {}).reduce((sum, h) => sum + (h.count ?? 0), 0) });
    } catch { /* Unrelated or incomplete files are not selectable archives. */ }
  }
  return archives.sort((a, b) => String(b.manifest.createdAt).localeCompare(String(a.manifest.createdAt)));
}

export async function runConsole() {
  const ui = new TerminalUI(); let client; let closing = false;
  const packageData = await readJson(new URL('../package.json', import.meta.url));
  const status = () => ui.setStatus(`v${packageData.version}  ·  ${client?.user ? `Verbunden: ${client.user.username}` : 'Discord: nicht verbunden'}  ·  ${process.env.AUTO_UPDATE === 'false' ? 'Updates aus' : 'Updates aktiv'}`);
  const shutdown = () => { closing = true; ui.cancelled = true; if (!ui.busy) ui.waiter?.({ key: { name: 'escape' } }); };
  const connect = async () => {
    if (client?.isReady()) return client;
    if (!process.env.DISCORD_TOKEN?.trim()) throw new Error('Discord-Token fehlt. Im Hauptmenü „Token ändern“ öffnen.');
    client?.destroy();
    const { Client, Options } = await import('discord.js-selfbot-v13');
    const initialPresence = buildPresence(presenceConfig());
    client = new Client({ presence: { status: 'online', afk: false, activities: [] }, captchaRetryLimit: 0, retryLimit: 0, restRequestTimeout: 30000, allowedMentions: { parse: [], repliedUser: false }, makeCache: Options.cacheWithLimits({ MessageManager: 0, PresenceManager: 0 }) });
    client.once('ready', () => client.user.setPresence(initialPresence));
    client.on('error', () => {});
    let timeout;
    try {
      await ui.task('Mit Discord verbinden', () => Promise.race([client.login(process.env.DISCORD_TOKEN.trim()), new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('Anmeldung nach 60 Sekunden abgebrochen.')), 60000); })]));
    } finally { clearTimeout(timeout); status(); }
    return client;
  };
  const pickGuild = async title => {
    await connect();
    const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!guilds.length) throw new Error('Für dieses Konto sind keine Server verfügbar.');
    return ui.choose(title, guilds.map(g => ({ value: g, label: g.name, hint: g.id, description: `Server-ID: ${g.id}` })), { description: 'Mit Pfeiltasten auswählen. Du musst keine Server-ID abtippen.' });
  };
  const pickArchive = async (completeOnly = false) => {
    const archives = (await listArchives()).filter(a => !completeOnly || a.manifest.complete);
    const items = archives.map(a => ({ value: a, label: a.name, hint: `${a.count} Nachrichten`, description: `${a.manifest.source.name} · ${a.manifest.complete ? 'Vollständig' : 'Export unterbrochen'}` }));
    items.push({ value: 'manual', label: 'Ordner manuell öffnen', description: 'Für Archive außerhalb des data-Ordners.' });
    const selected = await ui.choose('Archiv auswählen', items, { description: 'Deine gespeicherten Exporte auf diesem Gerät.' });
    if (selected !== 'manual') return selected;
    const dir = await ui.ask('Archivordner', { description: 'Pfad zum Ordner mit manifest.json', value: 'data/', validate: value => value.trim().length > 0 || 'Bitte einen Ordner angeben.' });
    if (dir === null) return null;
    return { dir: path.resolve(dir), name: path.basename(dir), manifest: await readJson(path.resolve(dir, 'manifest.json')) };
  };
  ui.open(); process.on('SIGTERM', shutdown);
  try {
    while (!closing) {
      status();
      const action = await ui.choose('Kommandozentrale', [
        { value: 'export', label: 'Server sichern', hint: 'Channels + Nachrichten', description: 'Sichtbare Channels, Threads und Nachrichten in ein lokales Archiv sichern.' },
        { value: 'import', label: 'Archiv übertragen', hint: 'Vorschau vor jedem Import', description: 'Ein vorhandenes Archiv auf einen anderen Discord-Server übertragen.' },
        { value: 'archives', label: 'Meine Archive', hint: 'Inhalte & Fortschritt', description: 'Gesicherte Server und unterbrochene Exporte ansehen.' },
        { value: 'servers', label: 'Meine Server', hint: 'Discord-Verbindung prüfen', description: 'Verfügbare Server anzeigen und Verbindung prüfen.' },
        { value: 'token', label: 'Token ändern', hint: 'Verdeckte Eingabe', description: 'Zugangsdaten ausschließlich lokal speichern. Bestehende Verbindung wird beendet.' },
        { value: 'exit', label: 'Beenden', hint: 'Zurück zur Konsole', description: 'Sitzung beenden. Gespeicherte Archive bleiben erhalten.' },
      ], { description: 'Sichern. Prüfen. Übertragen. Alles direkt im Terminal.' });
      if (!action || action === 'exit') break;
      try {
        if (action === 'token') {
          const token = await ui.ask('Discord-Token ändern', { description: 'Verdeckte Eingabe · Esc behält den bisherigen Token.', secret: true, validate: value => /^[A-Za-z0-9._-]{30,}$/.test(value) || 'Bitte einen gültigen Token ohne Leerzeichen eingeben.' });
          if (token === null) continue;
          let env = ''; try { env = await readFile('.env', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          env = env.split(/\r?\n/).filter(line => !/^\s*(export\s+)?DISCORD_TOKEN\s*=/.test(line)).join('\n');
          await writeFile('.env', env.trimEnd() + `\nDISCORD_TOKEN=${token}\n`, { mode: 0o600 }); await chmod('.env', 0o600);
          process.env.DISCORD_TOKEN = token; client?.destroy(); client = null; status();
          await ui.show('Token gespeichert', ['Der Token wurde nur in der lokalen .env gespeichert.', 'Beim nächsten Serverzugriff wird die Verbindung neu aufgebaut.']);
        } else if (action === 'servers') {
          const guild = await pickGuild('Meine Discord-Server');
          if (guild) await ui.show(guild.name, [`Server-ID: ${guild.id}`, 'Verbindung erfolgreich.', 'Zum Sichern im Hauptmenü „Server sichern“ öffnen.']);
        } else if (action === 'archives') {
          const archive = await pickArchive(); if (!archive) continue;
          const m = archive.manifest;
          const messages = Object.values(m.histories ?? {}).reduce((sum, h) => sum + (h.count ?? 0), 0);
          const choice = await ui.choose(m.source.name, [
            ...(m.complete ? [] : [{ value: 'resume', label: 'Export fortsetzen', description: 'Mit dem bereits gespeicherten Fortschritt weitermachen.' }]),
            { value: 'back', label: 'Zurück', description: 'Zurück zur Kommandozentrale.' },
          ], { description: `${m.channels.length} Channels · ${messages} Nachrichten · ${m.warnings.length} Hinweise`, notice: `${m.complete ? 'Vollständig' : 'Unterbrochen'} · ${archive.dir}` });
          if (choice === 'resume') {
            await connect(); const guild = client.guilds.cache.get(m.source.id);
            if (!guild) throw new Error('Quellserver nicht mehr verfügbar.');
            await ui.task('Export fortsetzen', options => lockDirectory(archive.dir, async () => exportGuild(guild, await guild.members.fetchMe(), archive.dir, { ...options, maxMessages: m.maxMessages, maxAttachmentMB: m.maxAttachmentMB })));
            await ui.show('Export abgeschlossen', [archive.dir]);
          }
        } else if (action === 'export') {
          const guild = await pickGuild('Quellserver auswählen'); if (!guild) continue;
          const name = await ui.ask('Archiv benennen', { description: 'Wird unter data/ gespeichert. Gleicher Name setzt einen Export fort.', value: `${guild.id}-${new Date().toISOString().slice(0, 10)}`, validate: value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value) || 'Buchstaben, Ziffern, - und _ verwenden (max. 80).' });
          if (name === null) continue;
          const limit = await ui.choose('Umfang des Exports', [
            { value: 0, label: 'Alle Nachrichten', description: 'Den vollständig lesbaren Verlauf vor dem Exportstart sichern.' },
            { value: 100, label: 'Neueste 100 je Channel', description: 'Kleiner Testexport zum Kennenlernen.' },
            { value: 1000, label: 'Neueste 1.000 je Channel', description: 'Ein begrenzter aktueller Ausschnitt.' },
          ]);
          if (limit === null) continue;
          const dir = path.resolve('data', name);
          const result = await ui.task(`Sichere ${guild.name}`, options => lockDirectory(dir, async () => exportGuild(guild, await guild.members.fetchMe(), dir, { ...options, maxMessages: limit })));
          await ui.show('Archiv gespeichert', [`${result.channels.length} Channels / Threads`, `${result.warnings.length} Hinweise im Manifest`, dir]);
        } else if (action === 'import') {
          const archive = await pickArchive(true); if (!archive) continue;
          const manifest = validateManifest(archive.manifest);
          const target = await pickGuild('Zielserver auswählen'); if (!target) continue;
          const plan = await ui.task('Import-Vorschau prüfen', async () => {
            await target.channels.fetch();
            return transferPlan(manifest, target, await readJson(path.join(archive.dir, `import-${target.id}.json`), null));
          });
          const confirmed = await ui.choose('Übertragung bestätigen', [
            { value: 'apply', label: 'Jetzt übertragen', description: `Ziel: ${target.name} (${target.id}). Neue Channels werden privat erstellt.` },
            { value: 'back', label: 'Zurück', description: 'Keine Änderungen am Zielserver vornehmen.' },
          ], { selected: 1, description: `${plan.source} → ${plan.target}`, notice: `${plan.newChannels} neue Channels · ${plan.newThreads} Threads · ${plan.messages} Nachrichten` });
          if (confirmed !== 'apply') continue;
          await ui.task(`Übertrage nach ${target.name}`, options => lockDirectory(archive.dir, () => importGuild(manifest, archive.dir, target, client.user.id, { ...options, apply: true })));
          await ui.show('Übertragung abgeschlossen', [`Ziel: ${target.name}`, 'Die neuen Channels sind privat.', 'Freigaben anschließend auf dem Zielserver einstellen.']);
        }
      } catch (error) { if (!closing) await ui.show('Vorgang angehalten', errorText(error).split('\n'), { error: true }); }
    }
  } finally { process.removeListener('SIGTERM', shutdown); client?.destroy(); ui.close(); }
}
