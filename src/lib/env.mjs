import fs from 'node:fs/promises';
import path from 'node:path';

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

// The optional Jev player's key: the environment, then --env-file, then .env in the current folder.
export async function loadTypesafeApiKey(envFile) {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  const target = path.resolve(envFile || path.join(process.cwd(), '.env'));
  let contents;
  try {
    contents = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('TYPESAFE_API_KEY is not set and the environment file was not found'), { code: 'MISSING_API_KEY' });
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (entry?.[0] === 'TYPESAFE_API_KEY' && entry[1].trim()) return entry[1].trim();
  }
  throw Object.assign(new Error('TYPESAFE_API_KEY is missing or empty'), { code: 'MISSING_API_KEY' });
}

export async function hasTypesafeApiKey(envFile) {
  try {
    await loadTypesafeApiKey(envFile);
    return true;
  } catch (error) {
    if (error.code === 'MISSING_API_KEY') return false;
    throw error;
  }
}

async function loadNamedApiKey(name, envFile) {
  if (process.env[name]?.trim()) return process.env[name].trim();
  const target = path.resolve(envFile || path.join(process.cwd(), '.env'));
  let contents;
  try {
    contents = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error(`${name} is not set and the environment file was not found`), { code: 'MISSING_API_KEY' });
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (entry?.[0] === name && entry[1].trim()) return entry[1].trim();
  }
  throw Object.assign(new Error(`${name} is missing or empty`), { code: 'MISSING_API_KEY' });
}

export async function loadOpenAIApiKey(envFile) {
  return await loadNamedApiKey('OPENAI_API_KEY', envFile);
}

export async function hasOpenAIApiKey(envFile) {
  try {
    await loadOpenAIApiKey(envFile);
    return true;
  } catch (error) {
    if (error.code === 'MISSING_API_KEY') return false;
    throw error;
  }
}
