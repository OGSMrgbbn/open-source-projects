import { emitKeypressEvents } from 'node:readline';

// Terminal-native palette. No browser, fonts or rendering dependencies required.
const C = { reset: '\x1b[0m', bg: '\x1b[48;2;12;18;29m', white: '\x1b[38;2;232;239;249m', muted: '\x1b[38;2;132;151;173m', accent: '\x1b[38;2;92;211;225m', selected: '\x1b[48;2;27;63;79m', warn: '\x1b[38;2;246;195;111m', bold: '\x1b[1m' };
const segmenter = new Intl.Segmenter('de', { granularity: 'grapheme' });
export const clean = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const glyphWidth = text => /\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]/u.test(text) ? 2 : 1;
export function fit(value, width) {
  let text = '', used = 0;
  for (const { segment } of segmenter.segment(clean(value))) {
    const size = glyphWidth(segment);
    if (used + size > width) break;
    text += segment; used += size;
  }
  return text + ' '.repeat(Math.max(0, width - used));
}

export function renderScreen(model, { columns = 80, rows = 24, color = true } = {}) {
  const width = Math.max(1, Math.min(100, columns - 2));
  const height = Math.max(1, Math.min(30, rows - 1));
  const style = (text, kind = 'white') => color ? `${C.bg}${C[kind]}${text}${C.reset}` : text;
  const line = (text = '', kind) => style(` ${fit(text, width)}`, kind);
  if (columns < 36 || rows < 16) return [line('Fenster bitte vergrößern', 'accent'), line('Mindestens 36 × 16 Zeichen'), line('Q / Esc: zurück')].slice(0, height).join('\r\n');
  const lines = [line('MRGBBN  /  OPEN SOURCE', 'muted'), line('DISCORD TRANSFER', 'accent'), line(model.status ?? 'Bereit', 'muted'), line('─'.repeat(width), 'muted'), line(model.title ?? 'Kommandozentrale'), line(model.description ?? '', 'muted'), line()];
  const footerRows = 4;
  const available = Math.max(1, height - lines.length - footerRows);
  if (model.items?.length) {
    const selected = model.selected ?? 0;
    const start = Math.max(0, Math.min(selected - Math.floor(available / 2), model.items.length - available));
    model.items.slice(start, start + available).forEach((item, index) => {
      const actual = index + start;
      const prefix = actual === selected ? '›' : ' ';
      let text = `${prefix} ${actual + 1}. ${item.label}`;
      if (width >= 74 && item.hint) text = fit(text, 33) + item.hint;
      const content = ` ${fit(text, width)}`;
      lines.push(actual === selected && color ? `${C.selected}${C.accent}${C.bold}${content}${C.reset}` : style(content));
    });
  } else {
    for (const text of (model.lines ?? []).slice(-available)) lines.push(line(text));
  }
  while (lines.length < height - footerRows) lines.push(line());
  lines.push(line('─'.repeat(width), 'muted'));
  lines.push(line(model.notice ?? model.items?.[model.selected ?? 0]?.description ?? '', model.error ? 'warn' : 'muted'));
  lines.push(line(model.input !== undefined ? `› ${model.secret ? '•'.repeat([...model.input].length) : model.input}▏` : '', 'accent'));
  lines.push(line(model.footer ?? '↑ ↓  Navigieren    Enter  Öffnen    Esc / 0  Zurück', 'muted'));
  return lines.slice(0, height).join('\r\n');
}

export class TerminalUI {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input; this.output = output; this.model = {}; this.waiter = null; this.keyQueue = []; this.busy = false; this.cancelled = false;
    this.onKey = (text, key = {}) => {
      if (this.busy) {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.cancelled = true; this.model.notice = 'Stopp angefordert. Laufender Schritt wird gespeichert.'; this.draw(); }
        return;
      }
      const event = { text, key };
      if (this.waiter) this.waiter(event);
      else this.keyQueue.push(event);
    };
    this.onResize = () => this.draw();
  }
  open() {
    this.wasRaw = this.input.isRaw;
    emitKeypressEvents(this.input); this.input.setRawMode(true); this.input.resume();
    this.input.on('keypress', this.onKey); this.output.on('resize', this.onResize);
    this.output.write('\x1b[?1049h\x1b[?25l');
  }
  close() {
    this.input.removeListener('keypress', this.onKey); this.output.removeListener('resize', this.onResize);
    this.input.setRawMode(Boolean(this.wasRaw)); this.input.pause();
    this.output.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }
  draw() { this.output.write('\x1b[H\x1b[2J' + renderScreen(this.model, { columns: this.output.columns, rows: this.output.rows })); }
  nextKey() {
    if (this.keyQueue.length) return Promise.resolve(this.keyQueue.shift());
    return new Promise(resolve => { this.waiter = event => { this.waiter = null; resolve(event); }; });
  }
  setStatus(status) { this.status = status; }
  async choose(title, items, { description = '', lines = [], selected = 0, notice } = {}) {
    if (!items.length) return null;
    this.model = { title, description, items, selected, notice: notice ?? (lines.length ? lines.join(' · ') : undefined), status: this.status };
    for (;;) {
      this.draw();
      const { text, key } = await this.nextKey();
      if (key.name === 'escape' || text === '0' || (key.ctrl && key.name === 'c')) return null;
      if (key.name === 'up' || key.name === 'k') this.model.selected = (this.model.selected + items.length - 1) % items.length;
      if (key.name === 'down' || key.name === 'j') this.model.selected = (this.model.selected + 1) % items.length;
      if (key.name === 'home') this.model.selected = 0;
      if (key.name === 'end') this.model.selected = items.length - 1;
      if (key.name === 'pageup') this.model.selected = Math.max(0, this.model.selected - 8);
      if (key.name === 'pagedown') this.model.selected = Math.min(items.length - 1, this.model.selected + 8);
      if (/^[1-9]$/.test(text ?? '') && Number(text) <= items.length) this.model.selected = Number(text) - 1;
      if (key.name === 'return') return items[this.model.selected].value;
    }
  }
  async ask(title, { description = '', value = '', secret = false, validate = () => true } = {}) {
    this.model = { title, description, input: value, secret, status: this.status, footer: 'Enter  Bestätigen    Esc  Abbrechen    Ctrl+U  Leeren' };
    for (;;) {
      this.draw();
      const { text, key } = await this.nextKey();
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return null;
      if (key.ctrl && key.name === 'u') this.model.input = '';
      else if (key.name === 'backspace') this.model.input = [...segmenter.segment(this.model.input)].slice(0, -1).map(s => s.segment).join('');
      else if (key.name === 'return') {
        const result = validate(this.model.input);
        if (result === true) return this.model.input;
        this.model.notice = result; this.model.error = true;
      } else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text) && this.model.input.length < 512) this.model.input += text;
    }
  }
  async show(title, lines, { error = false } = {}) {
    this.model = { title, lines, error, status: this.status, notice: error ? 'Vorgang nicht abgeschlossen. Fortschritt bleibt erhalten.' : '', footer: 'Beliebige Taste  Zurück zum Menü' };
    this.draw(); await this.nextKey();
  }
  async task(title, action) {
    this.busy = true; this.cancelled = false; this.keyQueue = [];
    this.model = { title, status: this.status, description: 'Bitte warten …', lines: [], footer: 'Esc  Sicher anhalten · laufender Schritt wird zuerst gespeichert' };
    this.draw();
    const log = message => {
      this.model.lines.push(...String(message).split('\n')); this.model.lines = this.model.lines.slice(-30); this.draw();
    };
    try { return await action({ log, stopped: () => this.cancelled }); }
    finally { this.busy = false; }
  }
}
