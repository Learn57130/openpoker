import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Saved games, personas and Learner policies. OPENPOKER_HOME moves them; --output-dir overrides both.
export const DEFAULT_OUTPUT_DIR = process.env.OPENPOKER_HOME?.trim() ? path.resolve(process.env.OPENPOKER_HOME.trim()) : path.join(os.homedir(), '.openpoker');
export const DEFAULT_MODEL = 'jev-latest';
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
