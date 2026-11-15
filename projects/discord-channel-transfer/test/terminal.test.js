import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TerminalUI, renderScreen, clean, fit } from '../src/terminal.js';
import { listArchives } from '../src/console-app.js';
import { saveJson } from '../src/storage.js';

function terminal(t) {
  const input = new EventEmitter(); input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; }; input.resume = () => {}; input.pause = () => {};
  const output = new EventEmitter(); output.columns = 80; output.rows = 24;
  const frames = []; output.write = text => frames.push(text);
  const ui = new TerminalUI({ input, output }); ui.open(); t.after(() => ui.close());
  return { ui, input, frames, key: (name, text, extra = {}) => input.emit('keypress', text, { name, ...extra }) };
}

test('Terminal-Menü navigiert mit Pfeiltasten und führt erst mit Enter aus', async t => {
  const { ui, key, frames } = terminal(t);
  const selection = ui.choose('Menü', [{ value: 'a', label: 'Sichern' }, { value: 'b', label: 'Übertragen' }]);
  key('down'); key('return');
  assert.equal(await selection, 'b'); assert.ok(frames.some(f => f.includes('› 2. Übertragen')));
});

test('Schnelle Eingaben und eingefügte Zeichen gehen nicht zwischen zwei Promises verloren', async t => {
  const { ui, key } = terminal(t);
  const answer = ui.ask('Archivname');
  for (const char of 'mein-backup') key(char, char);
  key('return');
  assert.equal(await answer, 'mein-backup');
});

test('Escape bricht Auswahl und Eingaben ab', async t => {
  const { ui, key } = terminal(t);
  const selection = ui.choose('Menü', [{ value: 'a', label: 'Sichern' }]); key('escape'); assert.equal(await selection, null);
  const answer = ui.ask('Name'); key('escape'); assert.equal(await answer, null);
});

test('Verdeckte Eingabe erscheint nicht in Render-Frames', async t => {
  const { ui, key, frames } = terminal(t);
  const answer = ui.ask('Token', { secret: true });
  key('s', 'SYNTHETIC-SECRET'); await Promise.resolve(); key('return');
  assert.equal(await answer, 'SYNTHETIC-SECRET');
  assert.ok(frames.every(frame => !frame.includes('SYNTHETIC-SECRET')));
  assert.ok(frames.some(frame => frame.includes('•••')));
});

test('Stopp während eines Jobs setzt Abbruchsignal, ohne den Job hart zu beenden', async t => {
  const { ui, key } = terminal(t); let finish;
  const job = ui.task('Export', async ({ stopped, log }) => {
    log('Seite 1 gespeichert'); await new Promise(resolve => { finish = resolve; }); return stopped();
  });
  key('escape'); finish(); assert.equal(await job, true); assert.equal(ui.busy, false);
});

test('Renderer passt in breite und schmale Terminals; Servernamen können keine ANSI-Sequenzen einschleusen', () => {
  const model = { title: 'Quellserver', items: Array.from({ length: 30 }, (_, i) => ({ label: `Server ${i}`, description: 'Beschreibung' })), selected: 29 };
  for (const [columns, rows] of [[100, 30], [60, 20], [36, 16], [25, 10], [200, 90]]) {
    const screen = renderScreen(model, { columns, rows, color: false });
    assert.ok(screen.split('\r\n').length <= rows - 1);
    assert.ok(screen.split('\r\n').length <= 30);
    assert.ok(screen.split('\r\n').every(line => line.length < columns));
    if (columns >= 36) assert.ok(screen.includes('Server 29'));
  }
  assert.equal(clean('\x1b[2Jbad\r\nname'), 'bad  name');
  assert.equal(fit('界界', 3), '界 ');
});

test('Archivliste zeigt fertige und fortsetzbare Archive und ignoriert fremde Ordner', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'transfer-archive-ui-'));
  t.after(async () => {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'transfer-archive-ui-')) throw new Error('Unsicherer Testpfad');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'other'));
  await saveJson(path.join(root, 'first', 'manifest.json'), { version: 1, source: { id: '111111111111111111' }, complete: true, createdAt: '2026-01-01', histories: { a: { count: 7 } } });
  await saveJson(path.join(root, 'second', 'manifest.json'), { version: 1, source: { id: '111111111111111111' }, complete: false, createdAt: '2026-02-01', histories: {} });
  const items = await listArchives(root);
  assert.equal(items.length, 2); assert.equal(items[0].name, 'second'); assert.equal(items[1].count, 7);
});
