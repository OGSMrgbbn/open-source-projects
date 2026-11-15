import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hasPendingUpdate, repositoryRoot, updateProject, withRuntimeLock } from './updater.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const updateOnly = args[0] === '--update-only';
const log = message => console.log(`[Update] ${message}`);

async function run() {
  // One repository-wide lock also covers the child process, preventing timer/startup
  // updates from replacing code or node_modules during a transfer.
  const root = await repositoryRoot(projectDir) ?? projectDir;
  const result = await withRuntimeLock(root, async () => {
    const disabled = process.env.AUTO_UPDATE === 'false';
    if (disabled && await hasPendingUpdate(projectDir)) throw new Error('Ein Update ist unvollständig. Mit AUTO_UPDATE=true und npm run update reparieren.');
    if (disabled) log('Automatische Updates sind deaktiviert.');
    else await updateProject(projectDir, { log });
    if (updateOnly) return { status: 'finished' };
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', path.join(projectDir, 'src', 'cli.js'), ...args], {
      cwd: projectDir, env: process.env, stdio: 'inherit', windowsHide: true,
    });
    // Terminal signals reach both processes. Keep the parent lock until the child
    // has finished saving its checkpoint. systemd stops the entire control group.
    const waitForChild = () => {};
    process.on('SIGINT', waitForChild); process.on('SIGTERM', waitForChild);
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); resolve(); });
      });
    } finally { process.removeListener('SIGINT', waitForChild); process.removeListener('SIGTERM', waitForChild); }
    return { status: 'finished' };
  });
  if (result.status === 'busy') {
    log('Eine Sitzung oder ein Update läuft bereits. Dieser Aufruf wird übersprungen.');
    if (!updateOnly) process.exitCode = 1;
  }
}

run().catch(() => {
  // Git errors can contain authenticated remote URLs; never print raw command errors.
  console.error('[Update] Start/Update fehlgeschlagen. Git-Status und Verbindung prüfen; anschließend npm run update erneut ausführen. Bei vorhandener .update-pending.json startet das Tool erst nach erfolgreicher Reparatur.');
  process.exitCode = 1;
});
