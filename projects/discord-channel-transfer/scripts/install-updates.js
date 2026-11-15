import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function unitQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Ungültiger Pfad für systemd.');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

export function createUnits(projectDir, nodePath, npmPath, searchPath) {
  // Unlike ExecStart/Environment, WorkingDirectory is one path, not a word list.
  // Quotes here become part of the path and systemd rejects it as non-absolute.
  if (!projectDir.startsWith('/') || /[\r\n\0]/.test(projectDir)) throw new Error('Ungültiges systemd-Arbeitsverzeichnis.');
  const workingDirectory = projectDir.replaceAll('%', '%%');
  const service = `[Unit]\nDescription=Channel Transfer Git update\nAfter=network-online.target\n\n[Service]\nType=oneshot\nWorkingDirectory=${workingDirectory}\nEnvironment=${unitQuote(`PATH=${searchPath}`)}\nExecStart=${unitQuote(nodePath)} ${unitQuote(npmPath)} run update\nTimeoutStartSec=20min\nUMask=0077\n`;
  const timer = '[Unit]\nDescription=Check Channel Transfer updates every 15 minutes\n\n[Timer]\nOnCalendar=*:0/15\nRandomizedDelaySec=30\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n';
  return { service, timer };
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Der Hintergrund-Timer ist für Linux/Raspberry Pi. Updates beim Start funktionieren auch auf Windows.');
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!process.env.npm_execpath) throw new Error('Bitte npm run updates:enable verwenden.');
  const units = createUnits(projectDir, process.execPath, process.env.npm_execpath, process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin');
  const unitDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user');
  await mkdir(unitDir, { recursive: true });
  await writeFile(path.join(unitDir, 'channel-transfer-update.service'), units.service, { mode: 0o600 });
  await writeFile(path.join(unitDir, 'channel-transfer-update.timer'), units.timer, { mode: 0o600 });
  await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', '--now', 'channel-transfer-update.timer']);
  console.log('Update-Timer aktiv: alle 15 Minuten. Status: systemctl --user status channel-transfer-update.timer');
  console.log('Für Betrieb nach dem Abmelden einmal: loginctl enable-linger "$USER"');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
