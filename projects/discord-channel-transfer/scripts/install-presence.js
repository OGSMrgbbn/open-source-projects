import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unitQuote } from './install-updates.js';
const exec = promisify(execFile);

export function createPresenceUnit(projectDir, nodePath) {
  if (!projectDir.startsWith('/') || /[\r\n\0]/.test(projectDir)) throw new Error('Ungültiges Arbeitsverzeichnis.');
  return `[Unit]\nDescription=Discord Transfer permanent presence\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nWorkingDirectory=${projectDir.replaceAll('%', '%%')}\nExecStart=${unitQuote(nodePath)} --env-file=.env ${unitQuote(path.posix.join(projectDir, 'src/presence-daemon.js'))}\nRestart=always\nRestartSec=30\nTimeoutStopSec=10\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Diesen Befehl auf dem Raspberry Pi ausführen.');
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const unitDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd/user');
  await mkdir(unitDir, { recursive: true });
  await writeFile(path.join(unitDir, 'channel-transfer-presence.service'), createPresenceUnit(projectDir, process.execPath), { mode: 0o600 });
  await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', 'channel-transfer-presence.service']);
  await exec('systemctl', ['--user', 'restart', 'channel-transfer-presence.service']);
  console.log('Statusdienst aktiviert. Status: systemctl --user status channel-transfer-presence.service');
  console.log('Für Autostart ohne Anmeldung muss Linger aktiv sein: loginctl enable-linger "$USER"');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Installation fehlgeschlagen. systemd-Benutzerdienst und Pfade prüfen.'); process.exitCode = 1; });
