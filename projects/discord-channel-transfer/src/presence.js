export const DEFAULT_STATUSES = ['mrgbbn.Studio', 'mrgbbn.Studio | Im Studio', 'mrgbbn.Studio | Kreativ am Werk'];

export function presenceConfig(env = process.env) {
  const texts = env.PRESENCE_TEXTS ? JSON.parse(env.PRESENCE_TEXTS) : DEFAULT_STATUSES;
  if (!Array.isArray(texts) || !texts.length || texts.length > 20 || texts.some(text => typeof text !== 'string' || !text.trim() || text.length > 128 || /[\r\n\0]/.test(text))) {
    throw new Error('PRESENCE_TEXTS muss eine JSON-Liste mit 1–20 Texten (je 1–128 Zeichen) sein.');
  }
  const seconds = Number(env.PRESENCE_INTERVAL_SECONDS ?? 60);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86400) throw new Error('PRESENCE_INTERVAL_SECONDS muss zwischen 30 und 86400 liegen.');
  return { texts: texts.map(text => text.trim()), intervalMs: seconds * 1000 };
}

export function buildPresence(config, index = 0) {
  return {
    status: 'online', afk: false, since: 0,
    activities: [
      { name: 'mrgbbn.Studio', type: 'PLAYING' },
      { name: 'Custom Status', type: 'CUSTOM', state: config.texts[index % config.texts.length] },
    ],
  };
}

export function startPresence(client, config, { every = setInterval, cancel = clearInterval, log = () => {} } = {}) {
  let index = 0;
  const apply = () => {
    if (!client.isReady()) return;
    client.user.setPresence(buildPresence(config, index));
    log(`Online · Spiel: mrgbbn.Studio · Text ${index + 1}/${config.texts.length} gesetzt`);
  };
  const tick = () => { if (client.isReady()) { index = (index + 1) % config.texts.length; apply(); } };
  client.on('ready', apply);
  client.on('shardResume', apply);
  const timer = every(tick, config.intervalMs);
  apply();
  return () => { cancel(timer); client.removeListener('ready', apply); client.removeListener('shardResume', apply); };
}
