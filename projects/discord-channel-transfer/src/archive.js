import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { readJson, saveJson, safePath, sleep, snowflake } from './storage.js';

export const CHANNEL_TYPES = new Set(['GUILD_CATEGORY', 'GUILD_TEXT', 'GUILD_NEWS', 'GUILD_VOICE', 'GUILD_STAGE_VOICE', 'GUILD_FORUM', 'GUILD_MEDIA']);
export const THREAD_TYPES = new Set(['GUILD_PUBLIC_THREAD', 'GUILD_PRIVATE_THREAD', 'GUILD_NEWS_THREAD']);
const SETTINGS = ['topic', 'nsfw', 'bitrate', 'userLimit', 'rateLimitPerUser', 'rtcRegion', 'videoQualityMode', 'defaultSortOrder', 'defaultForumLayout', 'defaultThreadRateLimitPerUser', 'defaultAutoArchiveDuration'];

export function describeChannel(channel) {
  const settings = {};
  for (const key of SETTINGS) if (channel[key] != null) settings[key] = channel[key];
  if (channel.availableTags) settings.availableTags = channel.availableTags.map(tag => ({ name: tag.name, moderated: tag.moderated, emoji: tag.emoji?.id ? undefined : tag.emoji }));
  return {
    id: channel.id, name: channel.name, type: channel.type,
    parentId: channel.parentId ?? null, position: channel.rawPosition ?? 0,
    archived: channel.archived ?? false, settings,
  };
}

export function visibleChannels(channels, me) {
  return [...channels.values()].filter(c => CHANNEL_TYPES.has(c.type) && c.permissionsFor(me)?.has('VIEW_CHANNEL'));
}

export async function downloadAttachment(attachment, dir, relative, maxBytes, fetcher = fetch) {
  const target = safePath(dir, relative);
  try { if ((await stat(target)).size === attachment.size) return relative; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (attachment.size > maxBytes) throw new Error(`Datei über Download-Limit (${attachment.size} Bytes)`);
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) throw new Error('Kein Discord-Anhang-Link');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}`);
  await mkdir(path.dirname(target), { recursive: true });
  let bytes = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maxBytes ? new Error('Download-Limit überschritten') : null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(`${target}.part`, { mode: 0o600 }));
    if (bytes !== attachment.size) throw new Error('Anhang unvollständig');
    await rename(`${target}.part`, target);
  } catch (error) { await unlink(`${target}.part`).catch(() => {}); throw error; }
  return relative;
}

async function encodeMessage(message, dir, maxBytes, warn) {
  const attachments = [];
  for (const attachment of message.attachments.values()) {
    const item = { id: attachment.id, name: attachment.name, size: attachment.size, url: attachment.url };
    try {
      item.file = await downloadAttachment(attachment, dir, `attachments/${message.id}/${attachment.id}.bin`, maxBytes);
    } catch (error) { item.error = error.message; warn(`Anhang ${attachment.id}: ${error.message}`); }
    attachments.push(item);
  }
  return {
    id: message.id, author: { id: message.author?.id, name: message.author?.globalName ?? message.author?.username ?? 'Unbekannt' },
    createdAt: message.createdAt.toISOString(), editedAt: message.editedAt?.toISOString() ?? null,
    content: message.content ?? '', type: message.type, pinned: message.pinned,
    replyTo: message.reference?.messageId ?? null,
    embeds: message.embeds.map(e => e.toJSON()), attachments,
    stickers: [...message.stickers.values()].map(s => ({ id: s.id, name: s.name, url: s.url })),
    reactions: [...message.reactions.cache.values()].map(r => ({ emoji: r.emoji.toString(), count: r.count })),
  };
}

export async function exportGuild(guild, me, dir, { maxMessages = 0, maxAttachmentMB = 10, log = console.log, stopped = () => false } = {}) {
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest = await readJson(manifestPath, null);
  if (manifest && (manifest.source.id !== guild.id || manifest.maxMessages !== maxMessages || manifest.maxAttachmentMB !== maxAttachmentMB)) throw new Error('Dieses Archiv gehört zu einer anderen Quelle oder anderen Exportoptionen. Neuen Ordner verwenden.');
  if (manifest?.complete) { log('Archiv bereits vollständig. Für einen neuen Zeitpunkt einen neuen Ordner wählen.'); return manifest; }
  const warn = message => { manifest.warnings.push(message); log(`! ${message}`); };
  if (!manifest) {
    manifest = { version: 1, id: randomUUID(), source: { id: guild.id, name: guild.name }, createdAt: new Date().toISOString(), maxMessages, maxAttachmentMB, channels: [], histories: {}, warnings: [], complete: false, discovered: false };
    await saveJson(manifestPath, manifest);
  }
  if (!manifest.discovered) {
    const all = await guild.channels.fetch();
    const visible = visibleChannels(all, me);
    const found = new Map(visible.map(c => [c.id, c]));
    for (const channel of all.values()) {
      if (!CHANNEL_TYPES.has(channel.type) && !THREAD_TYPES.has(channel.type) && channel.permissionsFor(me)?.has('VIEW_CHANNEL')) warn(`Nicht unterstützter Channeltyp: ${channel.type} (${channel.name})`);
    }
    for (const channel of visible) {
      if (!channel.threads || !channel.permissionsFor(me)?.has('READ_MESSAGE_HISTORY')) continue;
      for (const archived of [false, true]) {
        let offset = 0;
        for (;;) {
          if (stopped()) throw new Error('Gestoppt. Export kann fortgesetzt werden.');
          const result = await channel.threads.fetchActive(false, { archived, limit: 100, offset });
          for (const thread of result.threads.values()) {
            if (thread.permissionsFor(me)?.has('VIEW_CHANNEL')) found.set(thread.id, thread);
          }
          if (!result.hasMore) break;
          if (!result.threads.size) throw new Error(`Thread-Paginierung ohne Fortschritt: ${channel.name}`);
          offset += result.threads.size;
          await sleep(350);
        }
      }
    }
    manifest.channels = [...found.values()].map(describeChannel);
    const ids = new Set(manifest.channels.map(c => c.id));
    for (const channel of manifest.channels) if (channel.parentId && !ids.has(channel.parentId)) channel.parentId = null;
    manifest.discovered = true;
    await saveJson(manifestPath, manifest);
  }
  for (const entry of manifest.channels) {
    if (stopped()) throw new Error('Gestoppt. Export kann fortgesetzt werden.');
    if (['GUILD_CATEGORY', 'GUILD_FORUM', 'GUILD_MEDIA'].includes(entry.type)) continue;
    const progress = manifest.histories[entry.id] ??= { pages: [], count: 0, before: null, done: false };
    if (progress.done) continue;
    const channel = await guild.client.channels.fetch(entry.id);
    if (!channel?.messages || !channel.permissionsFor(me)?.has(['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'])) {
      warn(`Kein Zugriff auf Nachrichtenverlauf: ${entry.name}`);
      progress.done = true;
      progress.skipped = true;
      await saveJson(manifestPath, manifest);
      continue;
    }
    log(`Export #${entry.name} (${progress.count} gespeichert)`);
    for (;;) {
      if (stopped()) throw new Error('Gestoppt. Export kann fortgesetzt werden.');
      const remaining = maxMessages ? maxMessages - progress.count : 100;
      if (remaining <= 0) { progress.done = true; break; }
      // Fix the snapshot boundary, including when resuming after a long pause.
      const options = { limit: Math.min(100, remaining) };
      if (progress.before) options.before = progress.before;
      else options.before = ((BigInt(Date.parse(manifest.createdAt)) - 1420070400000n) << 22n).toString();
      const page = [...(await channel.messages.fetch(options, { cache: false })).values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      if (!page.length) { progress.done = true; break; }
      const encoded = [];
      for (const message of page) encoded.push(await encodeMessage(message, dir, maxAttachmentMB * 1024 * 1024, warn));
      const relative = `messages/${entry.id}/${String(progress.pages.length).padStart(7, '0')}.json`;
      await saveJson(safePath(dir, relative), encoded);
      progress.pages.push(relative);
      progress.count += page.length;
      const next = page[0].id;
      if (progress.before && BigInt(next) >= BigInt(progress.before)) throw new Error('Nachrichten-Paginierung ohne Fortschritt.');
      progress.before = next;
      await saveJson(manifestPath, manifest);
      log(`  ${progress.count} Nachrichten`);
      await sleep(350);
    }
    await saveJson(manifestPath, manifest);
  }
  manifest.complete = true;
  await saveJson(manifestPath, manifest);
  log(`Export fertig: ${manifest.channels.length} Channels/Threads, ${manifest.warnings.length} Hinweise.`);
  return manifest;
}

export function validateManifest(manifest) {
  if (manifest?.version !== 1 || !manifest.complete || typeof manifest.id !== 'string' || !snowflake(manifest.source?.id) || !Array.isArray(manifest.channels)) throw new Error('Ungültiges oder unvollständiges Archiv. Export zuerst abschließen.');
  const ids = new Set();
  for (const c of manifest.channels) {
    if (!snowflake(c.id) || ids.has(c.id) || typeof c.name !== 'string' || !c.name.length || c.name.length > 100 || !(CHANNEL_TYPES.has(c.type) || THREAD_TYPES.has(c.type))) throw new Error('Ungültiger Channel im Archiv.');
    ids.add(c.id);
  }
  const map = new Map(manifest.channels.map(c => [c.id, c]));
  for (const c of manifest.channels) {
    const parent = map.get(c.parentId);
    if (THREAD_TYPES.has(c.type) && !parent) throw new Error('Thread ohne übergeordneten Channel.');
    if (c.parentId && (!parent || parent.id === c.id || (THREAD_TYPES.has(c.type) ? !['GUILD_TEXT', 'GUILD_NEWS', 'GUILD_FORUM', 'GUILD_MEDIA'].includes(parent.type) : parent.type !== 'GUILD_CATEGORY'))) throw new Error('Ungültige Channel-Hierarchie.');
  }
  return manifest;
}
