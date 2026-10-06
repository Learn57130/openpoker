import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { preparePrivateDirectory } from './lib/files.mjs';

const NAME = 'TYPESAFE_API_KEY';
// Letters, digits and a few URL-safe marks: nothing that could end a line or a value in a .env file.
const KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const LINE_PATTERN = /^\s*TYPESAFE_API_KEY\s*=/;

function keyError(message, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), { code });
}

function valueOf(line) {
  const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match || match[1] !== NAME) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.trim() || null;
}

async function readKeyFile(file) {
  let contents;
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const value = valueOf(line);
    if (value) return value;
  }
  return null;
}

function shown(file) {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

// Writes the file through a temporary copy and a rename, owner-readable only; a link in its place is refused.
// The data folder is made private as for saved games; another folder (an --env-file's) is left as it is.
async function writeKeyFile(file, transform, { privateFolder }) {
  if (privateFolder) await preparePrivateDirectory(path.dirname(file));
  else if (!(await fs.stat(path.dirname(file)).catch(() => null))?.isDirectory()) throw keyError('The folder for the key file does not exist, so the key was not saved', 'UNSAFE_OUTPUT');
  let before = '';
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw keyError('The key file is not a plain file, so the key was not saved', 'UNSAFE_OUTPUT');
    before = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lines = before ? before.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const after = transform(lines);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
  await fs.writeFile(temporary, after.length ? `${after.join('\n')}\n` : '', { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

/**
 * The Jev player's TypeSafe key, wherever it is: typed on the start screen (kept in memory), the
 * environment, or a .env file. The key itself never leaves this module except through get().
 *
 * Order: the page's key, TYPESAFE_API_KEY, then --env-file when given, otherwise .env in the folder the
 * table starts from and .env in the data folder. "Remember" saves to --env-file when given, otherwise
 * to the data folder's .env.
 */
export function createJevKeyStore({ envFile = null, dataDir, cwd = process.cwd(), env = process.env } = {}) {
  if (!dataDir) throw new TypeError('createJevKeyStore requires dataDir');
  const rememberFile = path.resolve(envFile || path.join(dataDir, '.env'));
  const files = envFile ? [path.resolve(envFile)] : [path.resolve(cwd, '.env'), path.resolve(dataDir, '.env')];
  const privateFolder = !envFile;
  let pageKey = null;
  let remembered = false;

  async function find() {
    if (pageKey) return { key: pageKey, source: 'page', file: remembered ? rememberFile : null };
    if (env[NAME]?.trim()) return { key: env[NAME].trim(), source: 'environment', file: null };
    for (const file of files) {
      const key = await readKeyFile(file);
      if (key) return { key, source: 'file', file };
    }
    return { key: null, source: null, file: null };
  }

  return {
    async status() {
      const found = await find();
      return {
        set: Boolean(found.key),
        source: found.source,
        file: found.file ? shown(found.file) : null,
        remembered: found.source === 'page' ? remembered : found.file === rememberFile,
        can_forget: found.source === 'page' || (found.source === 'file' && found.file === rememberFile),
        remember_file: shown(rememberFile)
      };
    },
    async has() {
      return Boolean((await find()).key);
    },
    async get() {
      const { key } = await find();
      if (!key) throw keyError('TYPESAFE_API_KEY is not set: add it on the start screen, or put it in the environment or a .env file', 'MISSING_API_KEY');
      return key;
    },
    // The message never repeats what was typed.
    async set(key, { remember = false } = {}) {
      const value = typeof key === 'string' ? key.trim() : '';
      if (!KEY_PATTERN.test(value)) throw keyError('That does not look like a TypeSafe key: it should be 16 to 512 letters, digits or . _ ~ + / = - characters');
      if (remember) {
        await writeKeyFile(rememberFile, lines => [...lines.filter(line => !LINE_PATTERN.test(line)), `${NAME}=${value}`], { privateFolder });
      }
      pageKey = value;
      remembered = Boolean(remember);
      return this.status();
    },
    async forget() {
      pageKey = null;
      remembered = false;
      const saved = await readKeyFile(rememberFile).catch(() => null);
      if (saved) await writeKeyFile(rememberFile, lines => lines.filter(line => !LINE_PATTERN.test(line)), { privateFolder });
      return this.status();
    }
  };
}
