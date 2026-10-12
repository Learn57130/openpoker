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

/**
 * One private JSON file with a schema name, read whole and written whole: mode 0600 in a 0700
 * directory, through a temporary file and a rename. Changes run one at a time.
 */
export function createPrivateJsonFile({ file, schema, empty, invalidCode = 'STORE_INVALID' }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('createPrivateJsonFile needs an absolute file path');
  let queue = Promise.resolve();

  async function load() {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw error;
    }
    const { schema_version: version, ...data } = JSON.parse(text);
    if (version !== schema) throw Object.assign(new Error(`${path.basename(file)} has an unknown format`), { code: invalidCode });
    return data;
  }

  async function save(data) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ schema_version: schema, ...data }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
  }

  return {
    /** The data as it is after every change already asked for. */
    async read() {
      await queue;
      return await load();
    },
    /** Reads the file, lets `edit` change the data in place, writes it back, and returns what `edit` returned. */
    change(edit) {
      const result = queue.then(async () => {
        const data = await load();
        const value = await edit(data);
        await save(data);
        return value;
      });
      queue = result.catch(() => {});
      return result;
    }
  };
}
