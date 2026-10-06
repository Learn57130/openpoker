import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_OUTPUT_DIR } from './lib/constants.mjs';
import { preparePrivateDirectory } from './lib/files.mjs';

/** Writes one match report as a private JSON file under `<outputDir>/poker/`. */
export async function writePokerLog(report, outputDir = DEFAULT_OUTPUT_DIR) {
  if (!report?.run_id) throw new TypeError('Poker log requires run_id');
  const directory = await preparePrivateDirectory(path.join(path.resolve(outputDir), 'poker'));
  const jsonPath = path.join(directory, `${report.run_id}.json`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { json: jsonPath };
}
