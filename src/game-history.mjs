import fs from 'node:fs/promises';
import path from 'node:path';

// The shape `makeRunId()` gives a match log's file name. Nothing else is read from the directory.
export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
// Games people played. `--auto` reports are measurement runs and are left out.
const LISTED_MODES = Object.freeze({ web: 'table', interactive: 'terminal' });

function historyError(message, code) {
  return Object.assign(new Error(message), { code });
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const list = value => (Array.isArray(value) ? value : []);

// The player type of each seat. Web logs name it; the terminal game and older logs give only the player's kind.
function seatTypes(report) {
  return list(report.players).map((player, seat) => report.seats?.[seat]?.type ?? player?.kind ?? null);
}

// A hand as the table showed it: the person's own cards, showdown cards, or every hand when nobody sat down.
// A folded hand is never shown. Model replies and agent notes are untrusted text and are left out.
export function handRecord(hand, { showAll = false, personSeat = null, privateSeats = new Set() } = {}) {
  const actions = list(hand.actions);
  const folded = new Set(actions.filter(action => action.label === 'fold').map(action => action.seat));
  const result = hand.result ?? {};
  const showdown = result.reason === 'showdown';
  const holeCards = list(hand.hole_cards);
  const cards = holeCards.map((held, seat) => {
    if (!Array.isArray(held)) return null;
    if (showdown && !folded.has(seat)) return held.map(String);
    // A friend's cards were theirs alone: the table never showed them before a showdown.
    if (privateSeats.has(seat)) return null;
    if (showAll || seat === personSeat) return held.map(String);
    return null;
  });
  const shownAtShowdown = seat => showdown && cards[seat] && !folded.has(seat);
  return {
    number: hand.hand_number,
    button: hand.button,
    starting_stacks: list(hand.starting_stacks),
    dealt_in: holeCards.map(Array.isArray),
    cards,
    board: list(hand.board).map(String),
    actions: actions.map(({ seat, street, label, amount, to, think_ms: thinkMs, meta }) => ({
      seat,
      street,
      label,
      amount,
      to,
      think_ms: finite(thinkMs) ? thinkMs : null,
      timed_out: meta?.reason === 'timeout',
      stand_in: meta?.source === 'fallback' && meta?.reason !== 'timeout',
      model: typeof meta?.model === 'string' ? meta.model.slice(0, 64) : null,
      confidence: meta?.source === 'jev' && finite(meta.confidence) ? meta.confidence : null
    })),
    result: {
      reason: result.reason ?? null,
      winners: list(result.winners),
      pot: finite(result.pot) ? result.pot : null,
      pots: list(result.pots).map(pot => ({ amount: pot.amount, eligible: list(pot.eligible), winners: list(pot.winners) })),
      net: list(result.net),
      hand_names: list(result.hand_names).map((name, seat) => (shownAtShowdown(seat) && typeof name === 'string' ? name : null))
    }
  };
}

/** One line of the game list, from a saved match log or the running game. */
export function gameSummary(report) {
  const types = seatTypes(report);
  const finalStacks = list(report.final_stacks);
  const handsPlayed = finite(report.hands_played) ? report.hands_played : list(report.log).length;
  const most = finalStacks.length ? Math.max(...finalStacks) : null;
  const leaders = finalStacks.filter(chips => chips === most).length;
  const endedAt = report.in_progress ? null : report.created_at ?? null;
  const ended = endedAt ? Date.parse(endedAt) : NaN;
  return {
    id: report.run_id,
    source: LISTED_MODES[report.mode] ?? 'table',
    in_progress: Boolean(report.in_progress),
    started_at: report.started_at ?? (Number.isFinite(ended) && finite(report.duration_ms) ? new Date(ended - report.duration_ms).toISOString() : endedAt),
    ended_at: endedAt,
    duration_ms: finite(report.duration_ms) ? report.duration_ms : null,
    stop_reason: report.in_progress ? null : report.stop_reason ?? null,
    hands_played: handsPlayed,
    blinds: { small: report.blinds?.small ?? null, big: report.blinds?.big ?? null },
    starting_stack: report.starting_stack ?? null,
    turn_limit_ms: finite(report.decision_timeout_ms) ? report.decision_timeout_ms : null,
    spectator: types[0] !== 'human',
    players: list(report.players).map((player, seat) => ({
      seat,
      name: String(player?.name ?? `Seat ${seat}`),
      type: types[seat],
      model: report.seats?.[seat]?.model ?? null,
      net_chips: finite(player?.net_chips) ? player.net_chips : null,
      final_stack: finite(finalStacks[seat]) ? finalStacks[seat] : null
    })),
    // The one player with the most chips; a tie, or a game with no finished hand, has none.
    winner_seat: handsPlayed > 0 && leaders === 1 ? finalStacks.indexOf(most) : null
  };
}

/** A whole game: its line in the list plus every hand. */
export function gameDetail(report) {
  const summary = gameSummary(report);
  const personSeat = summary.spectator ? null : 0;
  const privateSeats = new Set(seatTypes(report).flatMap((type, seat) => (type === 'friend' ? [seat] : [])));
  return { ...summary, hands: list(report.log).map(hand => handRecord(hand, { showAll: summary.spectator, personSeat, privateSeats })) };
}

const listed = report => Boolean(report) && typeof report === 'object' && Object.hasOwn(LISTED_MODES, report.mode) && Array.isArray(report.players);

/**
 * Reads the saved match logs in one directory. Logs are written once and never changed, so each
 * file's summary is worked out once and kept.
 */
export function createGameHistory({ directory } = {}) {
  if (!directory) throw new TypeError('createGameHistory requires a directory');
  const root = path.resolve(directory);
  const summaries = new Map();

  // Null when the file cannot be read or parsed, which includes a log still being written.
  async function readLog(name) {
    try {
      return JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
    } catch {
      return null;
    }
  }

  return {
    async list() {
      let names;
      try {
        names = await fs.readdir(root);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const logs = names.filter(name => name.endsWith('.json') && RUN_ID_PATTERN.test(name.slice(0, -5)));
      for (const name of logs) {
        if (summaries.has(name)) continue;
        const report = await readLog(name);
        // A file that did not parse is not remembered, so a log caught mid-write is read again next time.
        if (report === null) continue;
        summaries.set(name, listed(report) ? gameSummary({ ...report, run_id: name.slice(0, -5) }) : null);
      }
      return logs
        .map(name => summaries.get(name))
        .filter(Boolean)
        .sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)) || b.id.localeCompare(a.id));
    },

    async get(id) {
      // Checked before a file name is built from it, so no other file can be reached.
      if (typeof id !== 'string' || !RUN_ID_PATTERN.test(id)) throw historyError('A game id looks like 2026-10-01T09-30-00-000Z-1a2b3c4d', 'INVALID_INPUT');
      const report = await readLog(`${id}.json`);
      if (!listed(report)) throw historyError(`No saved game ${id}`, 'GAME_NOT_FOUND');
      return gameDetail({ ...report, run_id: id });
    }
  };
}
