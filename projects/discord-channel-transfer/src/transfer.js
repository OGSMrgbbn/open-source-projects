import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readJson, saveJson, safePath, sleep, snowflake } from './storage.js';
import { THREAD_TYPES, validateManifest } from './archive.js';

const NO_MENTIONS = { parse: [], repliedUser: false };
const SETTINGS = ['topic', 'nsfw', 'bitrate', 'userLimit', 'rtcRegion', 'videoQualityMode', 'availableTags', 'defaultSortOrder', 'defaultForumLayout', 'defaultThreadRateLimitPerUser'];

export function channelOptions(entry, guild, userId, mapping) {
  const options = { type: entry.type, parent: entry.parentId ? mapping[entry.parentId] : undefined };
  for (const key of SETTINGS) if (entry.settings?.[key] != null) options[key] = entry.settings[key];
  if (options.bitrate) options.bitrate = Math.min(options.bitrate, guild.maximumBitrate ?? 96000);
  options.rateLimitPerUser = 0;
  options.permissionOverwrites = [
    { id: guild.id, type: 'role', deny: ['VIEW_CHANNEL'] },
    { id: userId, type: 'member', allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ATTACH_FILES', 'CONNECT', 'SPEAK', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS', 'SEND_MESSAGES_IN_THREADS', 'MANAGE_THREADS'] },
  ];
  return options;
}

function splitText(text, limit) {
  const parts = [];
  while (text.length) {
    let end = Math.min(limit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(0, end)); text = text.slice(end);
  }
  return parts.length ? parts : [''];
}

export function messageParts(message, archiveId) {
  const author = String(message.author?.name ?? 'Unbekannt').replace(/[\r\n`*_]/g, '').slice(0, 80);
  const header = `**${author}** · ${message.createdAt}${message.editedAt ? ' · bearbeitet' : ''}\n`;
  let body = message.content || '';
  if (message.replyTo) body += `\n↪ Antwort auf Original-Nachricht ${message.replyTo}`;
  for (const embed of message.embeds ?? []) {
    const lines = [embed.title, embed.description, embed.url, ...(embed.fields ?? []).map(f => `${f.name}: ${f.value}`), embed.image?.url, embed.video?.url].filter(Boolean);
    if (lines.length) body += `\n[Einbettung]\n${lines.join('\n')}`;
  }
  for (const sticker of message.stickers ?? []) body += `\n[Sticker: ${sticker.name}] ${sticker.url ?? ''}`;
  if (message.reactions?.length) body += `\n[Reaktionen] ${message.reactions.map(r => `${r.emoji} × ${r.count}`).join(' · ')}`;
  if (message.pinned) body += '\n[Im Original angeheftet]';
  if (!body.trim()) body = `[${message.type ?? 'Nachricht'}]`;
  const parts = splitText(body, 1550).map(content => ({ content: `${header}${content}` }));
  for (const attachment of message.attachments ?? []) {
    parts.push({ content: `${header}[Anhang: ${String(attachment.name).slice(0, 150)}]${attachment.file ? '' : `\n${attachment.url}\n(Nur Link: ${attachment.error ?? 'nicht lokal verfügbar'})`}`, attachment: attachment.file ? attachment : undefined });
  }
  return parts.map((part, index) => {
    const marker = `[Archiv ${archiveId.slice(0, 8)}:${message.id}:${index + 1}/${parts.length}]`;
    return { ...part, marker, content: `${part.content}\n${marker}`, nonce: createHash('sha256').update(`${archiveId}:${message.id}:${index}`).digest('hex').slice(0, 24) };
  });
}

export function transferPlan(manifest, target, state = null) {
  validateManifest(manifest);
  if (target.id === manifest.source.id) throw new Error('Quell- und Zielserver müssen verschieden sein.');
  if (state && (state.archiveId !== manifest.id || state.targetId !== target.id)) throw new Error('Fortsetzungsstand passt nicht zum Archiv/Ziel.');
  const pending = manifest.channels.filter(c => !state?.channels?.[c.id]);
  const regular = pending.filter(c => !THREAD_TYPES.has(c.type));
  if ((target.channels.channelCountWithoutThreads ?? target.channels.cache.size) + regular.length > 500) throw new Error('Der Zielserver würde das Limit von 500 Channels überschreiten.');
  const communityTypes = manifest.channels.filter(c => ['GUILD_NEWS', 'GUILD_STAGE_VOICE', 'GUILD_FORUM'].includes(c.type));
  if (communityTypes.length && !target.features.includes('COMMUNITY')) throw new Error('Für Ankündigungs-, Stage- oder Forum-Channels zuerst Community im Zielserver aktivieren.');
  return { source: manifest.source.name, target: target.name, newChannels: regular.length, newThreads: pending.length - regular.length, messages: Object.values(manifest.histories).reduce((sum, h) => sum + h.count, 0), warnings: manifest.warnings.length, private: true };
}

export async function* archivedMessages(dir, history) {
  for (const relative of [...(history?.pages ?? [])].reverse()) {
    const messages = await readJson(safePath(dir, relative));
    if (!Array.isArray(messages) || messages.length > 100) throw new Error('Ungültige Nachrichtenseite.');
    for (const message of messages) {
      if (!snowflake(message.id) || typeof message.createdAt !== 'string' || typeof message.content !== 'string') throw new Error('Ungültige Nachricht im Archiv.');
      yield message;
    }
  }
}

export async function importGuild(manifest, dir, target, userId, {
  apply = false, retryUncertain = false, log = console.log, stopped = () => false, delayMs = 1100,
} = {}) {
  const statePath = path.join(dir, `import-${target.id}.json`);
  let state = await readJson(statePath, null);
  const plan = transferPlan(manifest, target, state);
  log(JSON.stringify(plan, null, 2));
  if (!apply) { log('Vorschau: keine Änderung auf Discord.'); return plan; }
  const me = await target.members.fetchMe();
  const required = ['MANAGE_CHANNELS', 'MANAGE_ROLES', 'VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ATTACH_FILES', 'CONNECT', 'SPEAK', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS', 'SEND_MESSAGES_IN_THREADS', 'MANAGE_THREADS'];
  if (!me.permissions.has(required)) throw new Error('Im Zielserver fehlen Rechte. Benötigt: ' + required.join(', '));
  state ??= { version: 1, archiveId: manifest.id, targetId: target.id, channels: {}, messages: {}, finalized: {}, pending: null, complete: false };
  const save = () => saveJson(statePath, state);
  const check = () => { if (stopped()) throw new Error('Gestoppt. Import kann fortgesetzt werden.'); };
  await save();

  // A durable intent is saved BEFORE every non-idempotent Discord write.
  // If a connection dies after success, do not silently send/create twice.
  if (state.pending) {
    const pending = state.pending;
    if (pending.kind === 'message') {
      const channel = await target.client.channels.fetch(pending.channelId);
      const recent = await channel.messages.fetch({ limit: 100 }, { cache: false });
      const match = [...recent.values()].find(m => m.author?.id === userId && m.content.endsWith(pending.marker));
      if (match) state.messages[pending.sourceId] = { messageId: pending.messageId, part: pending.part };
      else if (!retryUncertain) throw new Error('Unklarer letzter Nachrichtenversand. Die letzten 100 Nachrichten enthalten keinen Archivmarker. Ziel prüfen; nur wenn nichts gesendet wurde mit --retry-uncertain fortsetzen.');
    } else {
      const entry = manifest.channels.find(c => c.id === pending.sourceId);
      let candidates;
      if (THREAD_TYPES.has(entry.type)) {
        const parent = await target.client.channels.fetch(state.channels[entry.parentId]);
        candidates = [];
        for (const archived of [false, true]) {
          for (let offset = 0;;) {
            const result = await parent.threads.fetchActive(false, { archived, limit: 100, offset });
            candidates.push(...result.threads.values());
            if (!result.hasMore) break;
            if (!result.threads.size) throw new Error('Thread-Suche ohne Fortschritt.');
            offset += result.threads.size;
          }
        }
      } else candidates = [...(await target.channels.fetch()).values()];
      const matches = candidates.filter(c => !pending.before.includes(c.id) && c.name === entry.name && c.type === entry.type && (c.parentId ?? null) === (state.channels[entry.parentId] ?? null));
      if (matches.length === 1) state.channels[entry.id] = matches[0].id;
      else if (matches.length > 1 || !retryUncertain) throw new Error('Unklare letzte Channel-Erstellung. Ziel und Importdatei prüfen. Wenn kein Channel erstellt wurde, mit --retry-uncertain erneut versuchen.');
    }
    state.pending = null;
    await save();
  }

  const order = [...manifest.channels].sort((a, b) => {
    const rank = c => c.type === 'GUILD_CATEGORY' ? 0 : THREAD_TYPES.has(c.type) ? 2 : 1;
    return rank(a) - rank(b) || a.position - b.position || a.id.localeCompare(b.id);
  });
  for (const entry of order) {
    check();
    if (state.channels[entry.id]) {
      const existing = await target.client.channels.fetch(state.channels[entry.id]);
      if (!existing || existing.guildId !== target.id || existing.type !== entry.type) throw new Error(`Bereits importierter Channel fehlt oder wurde verändert: ${entry.name}. Für einen neuen Import einen neuen Archivordner verwenden.`);
      continue;
    }
    const isThread = THREAD_TYPES.has(entry.type);
    const parent = isThread ? await target.client.channels.fetch(state.channels[entry.parentId]) : null;
    const before = [...target.channels.cache.keys()];
    state.pending = { kind: 'channel', sourceId: entry.id, before };
    await save();
    log(`Erstelle ${isThread ? 'Thread' : 'Channel'}: ${entry.name}`);
    let created;
    if (isThread) {
      const options = { name: entry.name, type: entry.type, autoArchiveDuration: 1440, rateLimitPerUser: 0, reason: 'Channel-Archiv importieren' };
      if (['GUILD_FORUM', 'GUILD_MEDIA'].includes(parent.type)) options.message = { content: 'Archivierter Beitrag. Originalnachrichten folgen chronologisch.', allowedMentions: NO_MENTIONS };
      if (parent.type === 'GUILD_NEWS') {
        // News threads require a starting message. This is part of the creation intent.
        const start = await parent.send({ content: `Archiv-Thread: ${entry.name}`, allowedMentions: NO_MENTIONS });
        options.startMessage = start.id;
      }
      created = await parent.threads.create(options);
    } else {
      created = await target.channels.create(entry.name, channelOptions(entry, target, userId, state.channels));
    }
    state.channels[entry.id] = created.id;
    state.pending = null;
    await save();
    await sleep(delayMs);
  }

  for (const entry of order) {
    check();
    if (state.finalized[entry.id]) continue;
    const channel = await target.client.channels.fetch(state.channels[entry.id]);
    const history = manifest.histories[entry.id];
    const cursor = state.messages[entry.id];
    if (history?.count) log(`Übertrage #${entry.name}: ${history.count} Nachrichten`);
    if (THREAD_TYPES.has(entry.type) && channel.archived) await channel.setArchived(false);
    for await (const message of archivedMessages(dir, history)) {
      if (cursor && BigInt(message.id) < BigInt(cursor.messageId)) continue;
      const parts = messageParts(message, manifest.id);
      for (let index = 0; index < parts.length; index++) {
        check();
        if (cursor && message.id === cursor.messageId && index <= cursor.part) continue;
        const part = parts[index];
        const payload = { content: part.content, nonce: part.nonce, allowedMentions: NO_MENTIONS };
        if (part.attachment) {
          const file = safePath(dir, part.attachment.file);
          const size = (await stat(file)).size;
          if (size > 10 * 1024 * 1024) {
            payload.content = `${part.content.slice(0, -part.marker.length)}Datei lokal im Archiv (${size} Bytes); Upload-Limit dieses Tools: 10 MiB.\n${part.marker}`;
          } else payload.files = [{ attachment: file, name: path.basename(part.attachment.name ?? 'attachment.bin').replace(/[\x00-\x1f]/g, '_') }];
        }
        state.pending = { kind: 'message', sourceId: entry.id, channelId: channel.id, messageId: message.id, part: index, marker: part.marker };
        await save();
        await channel.send(payload);
        state.messages[entry.id] = { messageId: message.id, part: index };
        state.pending = null;
        await save();
        await sleep(delayMs);
      }
    }
    if (THREAD_TYPES.has(entry.type)) {
      await channel.setRateLimitPerUser(entry.settings?.rateLimitPerUser ?? 0);
      if (entry.archived) await channel.setArchived(true);
    } else if (entry.type !== 'GUILD_CATEGORY') {
      const edits = {};
      if (entry.settings?.rateLimitPerUser != null) edits.rateLimitPerUser = entry.settings.rateLimitPerUser;
      if (entry.settings?.defaultAutoArchiveDuration != null) edits.defaultAutoArchiveDuration = entry.settings.defaultAutoArchiveDuration;
      if (Object.keys(edits).length) await channel.edit(edits);
    }
    state.finalized[entry.id] = true;
    await save();
  }
  state.complete = true;
  await save();
  log('Import abgeschlossen. Die neuen Channels sind privat; Freigaben im Zielserver einstellen.');
  return state;
}
