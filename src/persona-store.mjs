import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { places, ratingChanges, START_RATING } from './ranking.mjs';

export const PERSONA_SCHEMA = 'jev/poker-personas/v1';
export const PERSONA_LIMITS = Object.freeze({ max: 50, nameLength: 24, history: 200 });
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

function storeError(message, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), { code });
}

export function cleanPersonaName(name) {
  if (typeof name !== 'string') throw storeError('A persona needs a name');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw storeError('A persona name is one line of text');
  const text = name.trim().replace(/\s+/g, ' ');
  if (!text || text.length > PERSONA_LIMITS.nameLength || !NAME_PATTERN.test(text)) {
    throw storeError(`A persona name is 1 to ${PERSONA_LIMITS.nameLength} letters, digits, spaces, dots, dashes, underscores or apostrophes, starting with a letter or digit`);
  }
  return text;
}

// What a list shows: the record without its history, with the skill figures worked out.
function summarize(persona, rank) {
  const { history, ...record } = persona;
  return {
    ...record,
    rank,
    bb_per_100: persona.hands ? Number(((persona.net_big_blinds / persona.hands) * 100).toFixed(1)) : null,
    win_rate: persona.matches ? Number((persona.match_wins / persona.matches).toFixed(3)) : null,
    avg_think_ms: persona.decisions ? Math.round(persona.think_ms_total / persona.decisions) : null,
    last_played_at: history[0]?.at ?? null
  };
}

/**
 * Saved players for the poker table, kept in one private JSON file. A persona has a name, the
 * seat it plays (player type, model, reasoning, style), a skill rating that moves after every
 * match, running totals, and a history log of its matches.
 */
export function createPersonaStore({ file, now = () => new Date() }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('createPersonaStore needs an absolute file path');
  let queue = Promise.resolve();

  async function load() {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const parsed = JSON.parse(text);
    if (parsed?.schema_version !== PERSONA_SCHEMA || !Array.isArray(parsed.personas)) throw storeError('The persona file has an unknown format', 'PERSONA_STORE_INVALID');
    return parsed.personas;
  }

  async function save(personas) {
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ schema_version: PERSONA_SCHEMA, personas }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
  }

  // Every change reads, edits and writes the whole file; changes run one at a time.
  function change(edit) {
    const result = queue.then(async () => {
      const personas = await load();
      const value = await edit(personas);
      await save(personas);
      return value;
    });
    queue = result.catch(() => {});
    return result;
  }

  const ranked = personas => [...personas].sort((a, b) => b.rating - a.rating || a.created_at.localeCompare(b.created_at));

  return {
    async list() {
      await queue;
      return ranked(await load()).map((persona, index) => summarize(persona, index + 1));
    },

    async get(id) {
      await queue;
      const order = ranked(await load());
      const index = order.findIndex(persona => persona.id === id);
      if (index < 0) throw storeError('No persona has that id', 'PERSONA_NOT_FOUND');
      return { ...summarize(order[index], index + 1), history: order[index].history.map(entry => ({ ...entry })) };
    },

    /** `seat` is an already validated seat: `{ type, model, reasoning, style, style_note }`. */
    async create({ name, seat }) {
      const clean = cleanPersonaName(name);
      return await change(personas => {
        if (personas.length >= PERSONA_LIMITS.max) throw storeError(`At most ${PERSONA_LIMITS.max} personas can be saved`, 'PERSONA_LIMIT');
        if (personas.some(persona => persona.name.toLowerCase() === clean.toLowerCase())) throw storeError(`The name "${clean}" is already taken`, 'NAME_TAKEN');
        const persona = {
          id: randomUUID().slice(0, 12),
          name: clean,
          type: seat.type,
          model: seat.model ?? null,
          reasoning: seat.reasoning ?? null,
          style: seat.style ?? null,
          style_note: seat.style_note ?? null,
          created_at: now().toISOString(),
          rating: START_RATING,
          matches: 0,
          match_wins: 0,
          hands: 0,
          net_chips: 0,
          net_big_blinds: 0,
          decisions: 0,
          think_ms_total: 0,
          history: []
        };
        personas.push(persona);
        return summarize(persona, ranked(personas).indexOf(persona) + 1);
      });
    },

    async remove(id) {
      return await change(personas => {
        const index = personas.findIndex(persona => persona.id === id);
        if (index < 0) throw storeError('No persona has that id', 'PERSONA_NOT_FOUND');
        personas.splice(index, 1);
        return { removed: true };
      });
    },

    /**
     * Record one finished match. `seats` lists every player at the table in seat order; a seat
     * without `persona_id` is a guest, rated at the starting rating and not stored. Returns the
     * rating of each seat before and after.
     */
    async recordMatch({ hands, big_blind: bigBlind, stop_reason: stopReason = null, seats }) {
      return await change(personas => {
        const byId = new Map(personas.map(persona => [persona.id, persona]));
        const records = seats.map(seat => (seat.persona_id ? byId.get(seat.persona_id) ?? null : null));
        const before = records.map(record => record?.rating ?? START_RATING);
        const scores = seats.map(seat => seat.net_chips);
        const changes = ratingChanges(before.map((rating, index) => ({ rating, score: scores[index] })));
        const finish = places(scores);
        const at = now().toISOString();
        records.forEach((record, index) => {
          if (!record) return;
          const seat = seats[index];
          record.rating = before[index] + changes[index];
          record.matches += 1;
          if (finish[index] === 1 && scores.filter(score => score === scores[index]).length === 1) record.match_wins += 1;
          record.hands += hands;
          record.net_chips += seat.net_chips;
          record.net_big_blinds += seat.net_chips / bigBlind;
          record.decisions += seat.decisions ?? 0;
          record.think_ms_total += seat.think_ms_total ?? 0;
          record.history.unshift({
            at,
            hands,
            place: finish[index],
            of: seats.length,
            opponents: seats.filter((_, other) => other !== index).map(other => other.name),
            net_chips: seat.net_chips,
            bb_per_100: hands ? Number((((seat.net_chips / bigBlind) / hands) * 100).toFixed(1)) : null,
            rating_before: before[index],
            rating_after: record.rating,
            stop_reason: stopReason
          });
          record.history.length = Math.min(record.history.length, PERSONA_LIMITS.history);
        });
        return seats.map((seat, index) => ({ persona_id: records[index]?.id ?? null, name: seat.name, before: before[index], after: before[index] + (records[index] ? changes[index] : 0) }));
      });
    }
  };
}
