import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportGuild, visibleChannels, validateManifest, downloadAttachment } from '../src/archive.js';
import { archivedMessages, channelOptions, importGuild, messageParts, transferPlan } from '../src/transfer.js';
import { lockDirectory, readJson, saveJson, safePath } from '../src/storage.js';

const SOURCE = '111111111111111111';
const TARGET = '222222222222222222';
const USER = '333333333333333333';
const CHANNEL = '444444444444444444';
const CATEGORY = '555555555555555555';
const MSG1 = '666666666666666666';
const MSG2 = '666666666666666667';
const quiet = () => {};

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'channel-transfer-test-'));
  t.after(async () => {
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'channel-transfer-test-')) throw new Error('Unsicherer Testpfad');
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function manifest() {
  return { version: 1, id: 'test-archive-0001', complete: true, source: { id: SOURCE, name: 'Quelle' }, warnings: [], channels: [
    { id: CATEGORY, type: 'GUILD_CATEGORY', name: 'Bereich', parentId: null, position: 0, settings: {} },
    { id: CHANNEL, type: 'GUILD_TEXT', name: 'allgemein', parentId: CATEGORY, position: 1, settings: { topic: 'Hallo', rateLimitPerUser: 5 } },
  ], histories: { [CHANNEL]: { count: 2, pages: [`messages/${CHANNEL}/0.json`, `messages/${CHANNEL}/1.json`] } } };
}

function message(id, content = 'Hallo @everyone') {
  return { id, author: { id: USER, name: 'Mara' }, createdAt: '2026-01-01T12:00:00.000Z', content, attachments: [], embeds: [], stickers: [], reactions: [] };
}

async function prepare(t) {
  const dir = await temporary(t);
  const data = manifest();
  await saveJson(path.join(dir, 'manifest.json'), data);
  // Discord is fetched newest page first, each page is saved oldest first.
  await saveJson(safePath(dir, data.histories[CHANNEL].pages[0]), [message(MSG2)]);
  await saveJson(safePath(dir, data.histories[CHANNEL].pages[1]), [message(MSG1)]);
  return { dir, data };
}

function fakeTarget() {
  const cache = new Map();
  const sent = [];
  const created = [];
  let crashSend = false;
  let crashCreate = false;
  const guild = {
    id: TARGET, name: 'Ziel', features: ['COMMUNITY'], maximumBitrate: 96000,
    members: { fetchMe: async () => ({ permissions: { has: () => true } }) },
    client: { channels: { fetch: async id => cache.get(id) ?? null } },
    channels: { cache, fetch: async () => cache, create: async (name, options) => {
      const id = String(777777777777777770n + BigInt(created.length));
      const channel = {
        id, name, type: options.type, guildId: TARGET, parentId: options.parent ?? null,
        messages: { fetch: async () => new Map(sent.filter(m => m.channelId === id).map((m, index) => [String(index), m])) },
        send: async payload => {
          sent.push({ ...payload, channelId: id, author: { id: USER } });
          if (crashSend) { crashSend = false; throw new Error('Verbindung nach erfolgreichem Senden abgebrochen'); }
          return { id: '888888888888888888' };
        },
        edit: async options => { channel.edited = options; },
        setArchived: async value => { channel.archived = value; },
        setRateLimitPerUser: async value => { channel.slowmode = value; },
      };
      channel.threads = {
        fetchActive: async (cacheResult, { archived }) => ({ threads: new Map([...cache].filter(([, c]) => c.parentId === id && Boolean(c.archived) === archived)), hasMore: false }),
        create: async threadOptions => {
          const thread = await guild.channels.create(threadOptions.name, { ...threadOptions, parent: id, type: threadOptions.type ?? 'GUILD_PUBLIC_THREAD' });
          thread.intro = threadOptions.message;
          return thread;
        },
      };
      created.push({ name, options }); cache.set(id, channel);
      if (crashCreate) { crashCreate = false; throw new Error('Verbindung nach Channel-Erstellung abgebrochen'); }
      return channel;
    } },
  };
  return { guild, sent, created, failSend: () => { crashSend = true; }, failCreate: () => { crashCreate = true; } };
}

test('Vorschau schreibt keine Channels oder Nachrichten', async t => {
  const { dir, data } = await prepare(t); const target = fakeTarget();
  const plan = await importGuild(data, dir, target.guild, USER, { log: quiet });
  assert.equal(plan.newChannels, 2); assert.equal(plan.messages, 2);
  assert.equal(target.created.length, 0); assert.equal(target.sent.length, 0);
  assert.equal(await readJson(path.join(dir, `import-${TARGET}.json`), null), null);
});

test('Import ist chronologisch, privat, ohne Pings und wiederholbar', async t => {
  const { dir, data } = await prepare(t); const target = fakeTarget();
  const options = { apply: true, log: quiet, delayMs: 0 };
  const state = await importGuild(data, dir, target.guild, USER, options);
  assert.equal(state.complete, true);
  assert.equal(target.created[1].options.parent, state.channels[CATEGORY]);
  assert.deepEqual(target.created[1].options.permissionOverwrites[0].deny, ['VIEW_CHANNEL']);
  assert.ok(target.sent[0].content.includes(MSG1)); assert.ok(target.sent[1].content.includes(MSG2));
  assert.deepEqual(target.sent[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(target.guild.channels.cache.get(state.channels[CHANNEL]).edited.rateLimitPerUser, 5);
  await importGuild(data, dir, target.guild, USER, options);
  assert.equal(target.created.length, 2); assert.equal(target.sent.length, 2);
});

test('Abbruch nach erfolgreichem Versand wird ohne Doppelversand fortgesetzt', async t => {
  const { dir, data } = await prepare(t); const target = fakeTarget(); target.failSend();
  const options = { apply: true, log: quiet, delayMs: 0 };
  await assert.rejects(importGuild(data, dir, target.guild, USER, options), /Verbindung/);
  assert.equal((await readJson(path.join(dir, `import-${TARGET}.json`))).pending.kind, 'message');
  await importGuild(data, dir, target.guild, USER, options);
  assert.equal(target.sent.length, 2);
});

test('Abbruch nach Channel-Erstellung erzeugt bei Fortsetzung kein Duplikat', async t => {
  const { dir, data } = await prepare(t); const target = fakeTarget(); target.failCreate();
  const options = { apply: true, log: quiet, delayMs: 0 };
  await assert.rejects(importGuild(data, dir, target.guild, USER, options), /Verbindung/);
  await importGuild(data, dir, target.guild, USER, options);
  assert.equal(target.created.length, 2); assert.equal(target.sent.length, 2);
});

test('Forum-Beiträge werden im richtigen Parent erstellt und wieder archiviert', async t => {
  const { dir, data } = await prepare(t); const target = fakeTarget();
  const threadId = '999999999999999999';
  data.channels[1].type = 'GUILD_FORUM';
  data.channels.push({ id: threadId, name: 'Ein Beitrag', type: 'GUILD_PUBLIC_THREAD', parentId: CHANNEL, position: 0, archived: true, settings: { rateLimitPerUser: 12 } });
  data.histories[threadId] = data.histories[CHANNEL]; delete data.histories[CHANNEL];
  const state = await importGuild(data, dir, target.guild, USER, { apply: true, log: quiet, delayMs: 0 });
  const thread = target.guild.channels.cache.get(state.channels[threadId]);
  assert.equal(thread.parentId, state.channels[CHANNEL]);
  assert.equal(thread.archived, true); assert.equal(thread.slowmode, 12);
  assert.equal(thread.intro.allowedMentions.parse.length, 0);
  assert.equal(target.sent.length, 2);
  assert.ok(target.sent.every(m => m.channelId === thread.id));
});

test('Fehlende Zielrechte stoppen vor der ersten Änderung', async t => {
  const { dir, data } = await prepare(t); const target = fakeTarget();
  target.guild.members.fetchMe = async () => ({ permissions: { has: () => false } });
  await assert.rejects(importGuild(data, dir, target.guild, USER, { apply: true, log: quiet }), /fehlen Rechte/);
  assert.equal(target.created.length, 0);
});

test('Unklarer Versand wird nicht automatisch wiederholt', async t => {
  const { dir, data } = await prepare(t); const target = fakeTarget(); target.failSend();
  const options = { apply: true, log: quiet, delayMs: 0 };
  await assert.rejects(importGuild(data, dir, target.guild, USER, options));
  target.sent.splice(0);
  await assert.rejects(importGuild(data, dir, target.guild, USER, options), /Unklarer letzter/);
  assert.equal(target.sent.length, 0);
});

test('Gleicher Server, fehlende Community und Kapazitätsüberschreitung werden blockiert', () => {
  const data = manifest(); const { guild } = fakeTarget();
  assert.throws(() => transferPlan(data, { ...guild, id: SOURCE }), /verschieden/);
  assert.throws(() => transferPlan(data, { ...guild, channels: { channelCountWithoutThreads: 499 } }), /500/);
  data.channels[1].type = 'GUILD_FORUM';
  assert.throws(() => transferPlan(data, { ...guild, features: [] }), /Community/);
});

test('Sichtbarkeit wird anhand von VIEW_CHANNEL gefiltert', () => {
  const channels = new Map([
    ['a', { type: 'GUILD_TEXT', permissionsFor: () => ({ has: () => true }) }],
    ['b', { type: 'GUILD_TEXT', permissionsFor: () => ({ has: () => false }) }],
  ]);
  assert.equal(visibleChannels(channels, {}).length, 1);
});

test('Lange Nachrichten bleiben unter 2000 Zeichen und behalten Unicode', () => {
  const text = '😀'.repeat(5000);
  const parts = messageParts(message(MSG1, text), 'archive-00000001');
  assert.ok(parts.length > 1);
  for (const part of parts) { assert.ok(part.content.length <= 2000); assert.ok(part.content.endsWith(part.marker)); }
  assert.equal(parts.map(p => p.content).join('').match(/😀/gu).length, 5000);
});

test('Bitrate wird an den Zielserver angepasst', () => {
  const options = channelOptions({ type: 'GUILD_VOICE', settings: { bitrate: 384000 } }, { id: TARGET, maximumBitrate: 96000 }, USER, {});
  assert.equal(options.bitrate, 96000);
});

test('Ungültige Archive und Pfade werden zurückgewiesen', () => {
  assert.throws(() => safePath('/archive', '../secret'), /außerhalb/);
  const data = manifest(); data.channels[1].parentId = CHANNEL;
  assert.throws(() => validateManifest(data), /Hierarchie/);
  assert.throws(() => validateManifest({ ...manifest(), complete: false }), /unvollständiges/);
});

test('Archiv liest Nachrichten über Seitengrenzen chronologisch', async t => {
  const { dir, data } = await prepare(t); const ids = [];
  for await (const item of archivedMessages(dir, data.histories[CHANNEL])) ids.push(item.id);
  assert.deepEqual(ids, [MSG1, MSG2]);
});

test('Sperre verhindert zwei gleichzeitige Transfers', async t => {
  const dir = await temporary(t);
  await lockDirectory(dir, async () => {
    await assert.rejects(lockDirectory(dir, quiet), /gesperrt/);
  });
  await lockDirectory(dir, quiet);
});

test('Download prüft Größe, Herkunft und speichert Bytes', async t => {
  const dir = await temporary(t);
  const attachment = { url: 'https://cdn.discordapp.com/attachments/test', size: 3 };
  await downloadAttachment(attachment, dir, 'attachments/test.bin', 10, async () => new Response('abc'));
  assert.equal(await readFile(path.join(dir, 'attachments/test.bin'), 'utf8'), 'abc');
  await assert.rejects(downloadAttachment({ ...attachment, url: 'https://example.com/a' }, dir, 'other.bin', 10), /Discord/);
  await assert.rejects(downloadAttachment({ ...attachment, size: 11 }, dir, 'other.bin', 10), /Limit/);
});

test('Export paginiert, speichert Fortschritt und schließt bei zweitem Lauf ohne Abruf ab', async t => {
  const dir = await temporary(t); let fetchCount = 0;
  const rawMessage = id => ({ id, content: id, author: { id: USER, username: 'Mara' }, createdAt: new Date('2026-01-01'), attachments: new Map(), embeds: [], stickers: new Map(), reactions: { cache: new Map() } });
  const channel = { id: CHANNEL, name: 'chat', type: 'GUILD_TEXT', rawPosition: 0, permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => {
    fetchCount++;
    return fetchCount === 1 ? new Map([[MSG2, rawMessage(MSG2)], [MSG1, rawMessage(MSG1)]]) : new Map();
  } } };
  const guild = { id: SOURCE, name: 'Quelle', channels: { fetch: async () => new Map([[CHANNEL, channel]]) }, client: { channels: { fetch: async () => channel } } };
  const result = await exportGuild(guild, {}, dir, { log: quiet });
  assert.equal(result.complete, true); assert.equal(result.histories[CHANNEL].count, 2);
  const ids = [];
  for await (const item of archivedMessages(dir, result.histories[CHANNEL])) ids.push(item.id);
  assert.deepEqual(ids, [MSG1, MSG2]);
  await exportGuild(guild, {}, dir, { log: quiet });
  assert.equal(fetchCount, 2);
});
