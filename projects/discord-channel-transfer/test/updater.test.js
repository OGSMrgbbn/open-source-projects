import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, updateProject, hasPendingUpdate, withRuntimeLock, assertNoPrivateFiles } from '../src/updater.js';
import { createUnits, unitQuote } from '../scripts/install-updates.js';

const quiet = () => {};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'transfer-git-test-'));
  t.after(async () => {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'transfer-git-test-')) throw new Error('Unsicherer Testpfad');
    await rm(root, { recursive: true, force: true });
  });
  const origin = path.join(root, 'origin.git');
  const writer = path.join(root, 'writer');
  const clone = path.join(root, 'pi');
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['clone', origin, writer]);
  await git(writer, ['config', 'user.name', 'Updater Test']);
  await git(writer, ['config', 'user.email', 'updater-test@example.invalid']);
  const projectPath = path.join('projects', 'discord-channel-transfer');
  await mkdir(path.join(writer, projectPath), { recursive: true });
  await writeFile(path.join(writer, '.gitignore'), '.env\ndata/\n.repo-runtime.lock\n.update-pending.json\nnode_modules/\n');
  await writeFile(path.join(writer, projectPath, 'package.json'), JSON.stringify({ name: 'discord-channel-transfer', version: '1.0.0' }));
  await writeFile(path.join(writer, projectPath, 'app.txt'), 'version 1');
  await git(writer, ['add', '.']); await git(writer, ['commit', '-m', 'Initial project']); await git(writer, ['push', '-u', 'origin', 'main']);
  await git(root, ['clone', origin, clone]);
  const project = path.join(clone, projectPath);
  const publish = async (version = 'version 2') => {
    await writeFile(path.join(writer, projectPath, 'app.txt'), version);
    await git(writer, ['add', '.']); await git(writer, ['commit', '-m', version]); await git(writer, ['push']);
  };
  return { root, origin, writer, clone, project, projectPath, publish };
}

test('Git-Update im Sammelrepo aktualisiert Code und bewahrt Konfiguration/Archive', async t => {
  const f = await fixture(t); await f.publish();
  await writeFile(path.join(f.project, '.env'), 'LOCAL_SETTING=preserved');
  await mkdir(path.join(f.project, 'data')); await writeFile(path.join(f.project, 'data', 'archive.json'), 'private archive');
  let installs = 0;
  const result = await withRuntimeLock(f.clone, () => updateProject(f.project, { log: quiet, install: async dir => {
    installs++; assert.equal(dir, f.project); assert.equal(await readFile(path.join(dir, 'app.txt'), 'utf8'), 'version 2');
  } }));
  assert.equal(result.status, 'updated'); assert.equal(installs, 1);
  assert.equal(await readFile(path.join(f.project, '.env'), 'utf8'), 'LOCAL_SETTING=preserved');
  assert.equal(await readFile(path.join(f.project, 'data', 'archive.json'), 'utf8'), 'private archive');
  assert.equal(await hasPendingUpdate(f.project), false);
  assert.equal((await updateProject(f.project, { log: quiet, install: async () => { installs++; } })).status, 'current');
  assert.equal(installs, 1);
});

test('Lokale Änderungen werden nicht überschrieben', async t => {
  const f = await fixture(t); await f.publish();
  await writeFile(path.join(f.project, 'app.txt'), 'my changes');
  assert.equal((await updateProject(f.project, { log: quiet })).status, 'dirty');
  assert.equal(await readFile(path.join(f.project, 'app.txt'), 'utf8'), 'my changes');
});

test('Abweichender Git-Verlauf wird nicht automatisch zusammengeführt', async t => {
  const f = await fixture(t); await f.publish();
  await git(f.clone, ['config', 'user.name', 'Updater Test']); await git(f.clone, ['config', 'user.email', 'updater-test@example.invalid']);
  await writeFile(path.join(f.project, 'local.txt'), 'local commit');
  await git(f.clone, ['add', '.']); await git(f.clone, ['commit', '-m', 'local development']);
  assert.equal((await updateProject(f.project, { log: quiet })).status, 'diverged');
  assert.equal(await readFile(path.join(f.project, 'app.txt'), 'utf8'), 'version 1');
});

test('Fehlgeschlagene Installation bleibt markiert und wird beim nächsten Lauf repariert', async t => {
  const f = await fixture(t); await f.publish();
  await assert.rejects(updateProject(f.project, { log: quiet, install: async () => { throw new Error('npm failure'); } }), /npm failure/);
  assert.equal(await hasPendingUpdate(f.project), true);
  let repaired = false;
  assert.equal((await updateProject(f.project, { log: quiet, install: async () => { repaired = true; } })).status, 'updated');
  assert.equal(repaired, true); assert.equal(await hasPendingUpdate(f.project), false);
});

test('Offline bleibt installierter Code erhalten, unvollständiges Update bleibt blockiert', async t => {
  const f = await fixture(t);
  await git(f.clone, ['remote', 'set-url', 'origin', path.join(f.root, 'not-present.git')]);
  assert.equal((await updateProject(f.project, { log: quiet })).status, 'offline');
  assert.equal(await readFile(path.join(f.project, 'app.txt'), 'utf8'), 'version 1');
  await writeFile(path.join(f.project, '.update-pending.json'), '{}');
  await assert.rejects(updateProject(f.project, { log: quiet }), /Unvollständiges Update/);
});

test('Veröffentlichte lokale Datendateien werden vor dem Merge zurückgewiesen', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.writer, f.projectPath, '.env'), 'SYNTHETIC_TEST_ONLY=1');
  await git(f.writer, ['add', '--force', '.']); await git(f.writer, ['commit', '-m', 'bad publication fixture']); await git(f.writer, ['push']);
  await assert.rejects(updateProject(f.project, { log: quiet }), /geschützte lokale Dateien/);
  assert.equal(await hasPendingUpdate(f.project), false);
});

test('Repository-Sperre verhindert Update während laufender Sitzung', async t => {
  const f = await fixture(t);
  await withRuntimeLock(f.clone, async () => {
    const result = await withRuntimeLock(f.clone, () => { throw new Error('must not run'); });
    assert.equal(result.status, 'busy');
  });
  assert.equal(await withRuntimeLock(f.clone, async () => 'released'), 'released');
});

test('systemd-Units behandeln Leerzeichen und Prozentzeichen in Pfaden korrekt', () => {
  const units = createUnits('/home/a/Some Project', '/opt/node/bin/node', '/opt/node/npm-cli.js', '/a%b:/usr/bin');
  assert.ok(units.service.includes('WorkingDirectory=/home/a/Some Project\n'));
  assert.ok(units.service.includes('PATH=/a%%b:/usr/bin'));
  assert.ok(units.timer.includes('OnCalendar=*:0/15'));
  assert.throws(() => unitQuote('bad\npath'));
  assert.doesNotThrow(() => assertNoPrivateFiles('projects/tool/.env.example\nREADME.md'));
  assert.throws(() => assertNoPrivateFiles('projects/tool/.env.local'));
});

test('Linux systemd akzeptiert die erzeugte Service-Datei', { skip: process.platform !== 'linux' }, async t => {
  const execute = promisify(execFile);
  try { await execute('systemd-analyze', ['--version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('systemd-analyze nicht installiert'); return; } throw error; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'transfer-unit-test-'));
  t.after(async () => {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'transfer-unit-test-')) throw new Error('Unsicherer Testpfad');
    await rm(directory, { recursive: true, force: true });
  });
  const projectDirectory = path.join(directory, 'Some Project');
  await mkdir(projectDirectory);
  const servicePath = path.join(directory, 'channel-transfer-validation.service');
  await writeFile(servicePath, createUnits(projectDirectory, process.execPath, '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/bin:/bin').service);
  await execute('systemd-analyze', ['verify', '--man=no', servicePath]);
});
