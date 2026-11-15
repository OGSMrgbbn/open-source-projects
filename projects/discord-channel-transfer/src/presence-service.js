import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function refreshPresenceService(log = () => {}) {
  if (process.platform !== 'linux') return;
  try {
    const { stdout } = await exec('systemctl', ['--user', 'is-enabled', 'channel-transfer-presence.service'], { timeout: 10000 });
    if (stdout.trim() !== 'enabled') return;
  } catch { return; }
  try {
    await exec('systemctl', ['--user', 'restart', 'channel-transfer-presence.service'], { timeout: 20000 });
    log('Hintergrund-Statusdienst neu gestartet.');
  } catch { log('Statusdienst konnte nicht neu gestartet werden. systemctl --user status channel-transfer-presence.service prüfen.'); }
}
