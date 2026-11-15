import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { saveJson } from './storage.js';

const exec = promisify(execFile);
const pendingName = '.update-pending.json';

function buildEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  delete env.DISCORD_TOKEN;
  return env;
}

export async function git(cwd, args) {
  return (await exec('git', args, { cwd, env: buildEnvironment(), timeout: 45_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}

export async function repositoryRoot(projectDir) {
  try { return path.resolve(await git(projectDir, ['rev-parse', '--show-toplevel'])); }
  catch { return null; }
}

export async function withRuntimeLock(root, action) {
  const filename = path.join(root, '.repo-runtime.lock');
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return { status: 'busy' };
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally { await handle.close(); await unlink(filename); }
}

export async function hasPendingUpdate(projectDir) {
  try { await access(path.join(projectDir, pendingName)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function installAndVerify(projectDir, log = console.log) {
  // npm_execpath comes from npm start / npm run update. systemd invokes npm too.
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !path.isAbsolute(npmCli)) throw new Error('Updater über npm start bzw. npm run update ausführen.');
  for (const args of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'check'], ['test']]) {
    log(`npm ${args.join(' ')}`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npmCli, ...args], { cwd: projectDir, env: buildEnvironment(), stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm ${args[0]} fehlgeschlagen (Exit ${code}).`)));
    });
  }
}

export function assertNoPrivateFiles(files) {
  for (const file of files.split('\n')) {
    if (/(^|\/)(data|node_modules)(\/|$)/.test(file) || /(^|\/)\.env($|\.(?!example$))/.test(file) || /(^|\/)(\.repo-runtime\.lock|\.update-pending\.json)$/.test(file)) {
      throw new Error('Update enthält geschützte lokale Dateien. Veröffentlichung korrigieren.');
    }
  }
}

export async function updateProject(projectDir, { log = console.log, install = installAndVerify } = {}) {
  const root = await repositoryRoot(projectDir);
  const pending = await hasPendingUpdate(projectDir);
  if (!root) {
    if (pending) throw new Error('Unvollständiges Update ohne Git-Repository. Installation reparieren.');
    log('Kein Git-Clone: Auto-Update nicht eingerichtet. Für Updates das Repository klonen.');
    return { status: 'no-repository' };
  }
  let current;
  try { current = await git(root, ['rev-parse', '--verify', 'HEAD']); }
  catch { log('Noch kein Git-Commit vorhanden.'); return { status: 'unpublished' }; }
  const status = await git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (status) {
    if (pending) throw new Error('Unvollständiges Update und lokale Änderungen. Änderungen zuerst prüfen und committen oder separat sichern.');
    log('Auto-Update übersprungen: lokale Änderungen oder unversionierte Dateien vorhanden.');
    return { status: 'dirty' };
  }
  let branch, remote, ref;
  try {
    branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    remote = await git(root, ['config', '--get', `branch.${branch}.remote`]);
    ref = await git(root, ['config', '--get', `branch.${branch}.merge`]);
  } catch {
    if (pending) throw new Error('Tracking-Branch für unvollständiges Update fehlt.');
    log('Kein Tracking-Branch. Nach dem ersten Push bzw. git clone sind Updates verfügbar.');
    return { status: 'no-upstream' };
  }
  if (!remote || remote === '.' || remote.startsWith('-') || !ref.startsWith('refs/heads/')) throw new Error('Ungültige Git-Updatequelle. Einen Remote-Tracking-Branch verwenden.');
  try { await git(root, ['fetch', '--no-tags', '--', remote, ref]); }
  catch {
    if (pending) throw new Error('Unvollständiges Update; Updatequelle derzeit nicht erreichbar. Erneut versuchen.');
    log('Updatequelle nicht erreichbar. Die installierte Version bleibt aktiv.');
    return { status: 'offline' };
  }
  const incoming = await git(root, ['rev-parse', '--verify', 'FETCH_HEAD']);
  if (incoming !== current) {
    try { await git(root, ['merge-base', '--is-ancestor', current, incoming]); }
    catch {
      if (pending) throw new Error('Unvollständiges Update mit abweichendem Git-Verlauf. Manuell prüfen.');
      log('Update übersprungen: lokaler und veröffentlichter Git-Verlauf weichen ab.');
      return { status: 'diverged' };
    }
  }
  if (incoming === current && !pending) { log(`Aktuell: ${current.slice(0, 8)}`); return { status: 'current' }; }
  assertNoPrivateFiles(await git(root, ['ls-tree', '-r', '--name-only', incoming]));
  // Ask Git: Windows short paths and resolved symlinks may otherwise produce ../.
  const projectPrefix = (await git(projectDir, ['rev-parse', '--show-prefix'])).replace(/\/$/, '');
  const incomingPackage = JSON.parse(await git(root, ['show', `${incoming}:${projectPrefix ? `${projectPrefix}/` : ''}package.json`]));
  if (incomingPackage.name !== 'discord-channel-transfer') throw new Error('Update enthält nicht das erwartete Projekt.');
  // Persistent marker blocks application startup until dependencies AND tests pass,
  // including after power loss or a failed npm installation.
  await saveJson(path.join(projectDir, pendingName), { from: current, to: incoming, startedAt: new Date().toISOString() });
  if (incoming !== current) {
    log(`Übernehme Update ${current.slice(0, 8)} → ${incoming.slice(0, 8)}`);
    await git(root, ['merge', '--ff-only', '--no-edit', incoming]);
  } else log('Vervollständige unterbrochenes Update.');
  await install(projectDir, log);
  await unlink(path.join(projectDir, pendingName));
  const packageData = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
  log(`Update fertig: v${packageData.version} (${incoming.slice(0, 8)})`);
  return { status: 'updated', commit: incoming };
}
