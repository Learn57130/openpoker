import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_OUTPUT_DIR } from './constants.mjs';

export function makeRunId(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

/** Creates the folder for private files (mode 0700) and refuses a symbolic link in its place. */
export async function preparePrivateDirectory(directory) {
  const absolute = path.resolve(directory || DEFAULT_OUTPUT_DIR);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  // Checked before the permissions change, so a link's target is never touched.
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('Output directory must be a real directory'), { code: 'UNSAFE_OUTPUT' });
  await fs.chmod(absolute, 0o700);
  return absolute;
}
