import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function lockDirectory(dir, action) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, '.lock');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Archiv gesperrt: ${file}. Falls kein Transfer läuft, die alte Sperrdatei entfernen.`);
    throw error;
  }
  try { await handle.writeFile(String(process.pid)); return await action(); }
  finally { await handle.close(); await unlink(file); }
}

export function safePath(root, relative) {
  if (typeof relative !== 'string') throw new Error('Ungültiger Archivpfad.');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Archivpfad außerhalb des Archivs.');
  return resolved;
}

export const snowflake = value => typeof value === 'string' && /^\d{15,22}$/.test(value);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
