// Playing styles a seat can take. `tuning` moves the rule bot's thresholds: `raise_shift` is added
// to the strength needed to bet or raise, and `call_margin` is how far the chance of winning
// must clear the price before a call. A model seat gets `name` and `description` in its brief.
export const STYLES = Object.freeze([
  { id: 'balanced', name: 'Balanced', description: 'Plays by the odds with no particular lean.', tuning: { raise_shift: 0, call_margin: 0.03 } },
  { id: 'tight_aggressive', name: 'Tight-aggressive', description: 'Plays few hands, but bets and raises hard with the ones it plays.', tuning: { raise_shift: -0.07, call_margin: 0.1 } },
  { id: 'loose_aggressive', name: 'Loose-aggressive', description: 'Plays many hands, bets and raises often, and bluffs.', tuning: { raise_shift: -0.15, call_margin: -0.08 } },
  { id: 'tight_passive', name: 'Rock', description: 'Plays few hands, rarely raises, and gives up under pressure.', tuning: { raise_shift: 0.12, call_margin: 0.1 } },
  { id: 'loose_passive', name: 'Calling station', description: 'Calls a lot, rarely raises, and rarely folds.', tuning: { raise_shift: 0.15, call_margin: -0.15 } }
].map(style => Object.freeze({ ...style, tuning: Object.freeze(style.tuning) })));

export const DEFAULT_STYLE = 'balanced';
export const STYLE_NOTE_MAX = 200;

export function styleById(id) {
  return STYLES.find(style => style.id === (id ?? DEFAULT_STYLE)) ?? null;
}

/** A free-text style note from the table owner: one short printable line, or null. */
export function cleanStyleNote(note) {
  if (note === undefined || note === null || note === '') return null;
  if (typeof note !== 'string') throw Object.assign(new Error('style_note must be text'), { code: 'INVALID_INPUT' });
  const text = note.trim();
  // eslint-disable-next-line no-control-regex
  if (!text || text.length > STYLE_NOTE_MAX || /[\u0000-\u001f\u007f]/.test(text)) {
    throw Object.assign(new Error(`style_note must be one line of 1 to ${STYLE_NOTE_MAX} characters`), { code: 'INVALID_INPUT' });
  }
  return text;
}
