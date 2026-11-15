import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client } from 'discord.js-selfbot-v13';
import { buildPresence, presenceConfig, startPresence } from '../src/presence.js';
import { createPresenceUnit } from '../scripts/install-presence.js';

test('Presence bleibt online und behält das Spiel bei jedem Textwechsel', () => {
  const config = presenceConfig({ PRESENCE_TEXTS: '["Eins","Zwei"]', PRESENCE_INTERVAL_SECONDS: '30' });
  const client = new EventEmitter(); let ready = true; const seen = []; let tick; let cancelled;
  client.isReady = () => ready;
  client.user = { setPresence: presence => seen.push(presence) };
  const stop = startPresence(client, config, { every: (callback, ms) => { tick = callback; assert.equal(ms, 30000); return 42; }, cancel: timer => { cancelled = timer; } });
  tick(); tick(); ready = false; tick();
  assert.deepEqual(seen.map(p => p.activities[1].state), ['Eins', 'Zwei', 'Eins']);
  ready = true; client.emit('shardResume');
  assert.equal(seen.length, 4);
  for (const presence of seen) {
    assert.equal(presence.status, 'online'); assert.equal(presence.afk, false);
    assert.deepEqual(presence.activities[0], { name: 'mrgbbn.Studio', type: 'PLAYING' });
  }
  stop(); assert.equal(cancelled, 42); assert.equal(client.listenerCount('ready'), 0); assert.equal(client.listenerCount('shardResume'), 0);
});

test('Ungültige Texte und zu schnelle Statuswechsel werden abgelehnt', () => {
  for (const value of ['[]', '[""]', '[12]', '["a\\nb"]', 'null', 'not-json']) assert.throws(() => presenceConfig({ PRESENCE_TEXTS: value }));
  for (const value of ['0', '1', '29', 'NaN', '86401']) assert.throws(() => presenceConfig({ PRESENCE_INTERVAL_SECONDS: value }));
});

test('Installierte Discord-Bibliothek erzeugt PLAYING und CUSTOM im selben Gateway-Paket', t => {
  const client = new Client();
  t.after(() => client.destroy());
  client.user = { id: '123456789012345678' };
  client.presence.userId = client.user.id;
  const packets = []; client.ws.broadcast = packet => packets.push(packet);
  client.presence.set(buildPresence(presenceConfig({}), 1));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].op, 3);
  assert.equal(packets[0].d.status, 'online');
  assert.equal(packets[0].d.activities[0].type, 0);
  assert.equal(packets[0].d.activities[0].name, 'mrgbbn.Studio');
  assert.equal(packets[0].d.activities[1].type, 4);
  assert.equal(packets[0].d.activities[1].state, 'mrgbbn.Studio | Open Source');
});

test('Hintergrunddienst startet ohne Terminal und enthält keine Zugangsdaten', () => {
  const unit = createPresenceUnit('/home/test/My Project%name', '/opt/Node Path/node');
  assert.ok(unit.includes('WorkingDirectory=/home/test/My Project%%name\n'));
  assert.ok(unit.includes('ExecStart="/opt/Node Path/node" --env-file=.env'));
  assert.ok(unit.includes('Restart=always\nRestartSec=30'));
  assert.ok(unit.includes('WantedBy=default.target'));
  assert.ok(!unit.includes('DISCORD_TOKEN'));
  assert.throws(() => createPresenceUnit('/bad\npath', '/usr/bin/node'));
});
