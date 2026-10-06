import { randomBytes, timingSafeEqual } from 'node:crypto';
import { secureRandom, seededRandom } from './cards.mjs';
import { describeSituation } from './describe.mjs';
import { MAX_SEATS, MIN_SEATS } from './engine.mjs';
import { evaluateHand } from './evaluate.mjs';
import { gameDetail, gameSummary } from './game-history.mjs';
import { MATCH_LIMITS, playMatch } from './match.mjs';
import { cleanPersonaName } from './persona-store.mjs';
import { cleanStyleNote, DEFAULT_STYLE, styleById, STYLES } from './styles.mjs';

export const AGENT_SEAT_SCHEMA = 'jev/poker-seat/v2';
const MAX_NOTE_LENGTH = 200;
const MAX_WARNINGS = 3;
// Starts with a letter or digit, so a value can never be read as a command-line option.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
// Players that answer at once; the table holds their action on screen briefly so it can be followed.
const INSTANT_KINDS = new Set(['rule', 'jev', 'scripted']);

function quit() {
  return Object.assign(new Error('Game was replaced or stopped'), { code: 'PLAYER_QUIT' });
}

function tableError(message, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), { code });
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

// What the page may show about a player's choices once a hand is over.
// The friend's own view turned round so their seat is 0, which the page draws at the bottom.
function rotateSeats(view, offset) {
  const count = view.players.length;
  const turn = seat => (Number.isInteger(seat) && seat >= 0 ? (seat - offset + count) % count : seat);
  const spin = list => (Array.isArray(list) && list.length === count ? list.map((_, index) => list[(index + offset) % count]) : list);
  view.players = spin(view.players).map(player => ({ ...player, seat: turn(player.seat) }));
  const hand = view.hand;
  if (hand) {
    for (const key of ['button_seat', 'small_blind_seat', 'big_blind_seat', 'acting']) hand[key] = turn(hand[key]);
    for (const key of ['dealt_in', 'folded', 'all_in', 'cards', 'hand_names', 'stacks', 'bets', 'decisions']) hand[key] = spin(hand[key]);
    hand.log = hand.log.map(entry => ({ ...entry, seat: turn(entry.seat) }));
    if (hand.result) {
      hand.result.winner = turn(hand.result.winner);
      hand.result.winners = hand.result.winners.map(turn);
      hand.result.pots = hand.result.pots.map(pot => ({ ...pot, eligible: pot.eligible.map(turn), winners: pot.winners.map(turn) }));
      hand.result.net = spin(hand.result.net);
    }
  }
  if (view.totals) view.totals.net = spin(view.totals.net);
  const match = view.match;
  if (match) {
    match.net = spin(match.net);
    match.final_stacks = spin(match.final_stacks);
    match.winner_seat = turn(match.winner_seat);
    if (match.summary) {
      match.summary.seats = (match.summary.seats ?? []).map(entry => ({ ...entry, seat: turn(entry.seat) })).sort((a, b) => a.seat - b.seat);
      if (match.summary.biggest_pot) match.summary.biggest_pot.winners = match.summary.biggest_pot.winners.map(turn);
    }
    if (match.ratings) match.ratings = match.ratings.map(entry => ({ ...entry, seat: turn(entry.seat) }));
  }
  return view;
}

// A friend's name as the owner typed it, or null for the default "Friend".
function cleanFriendName(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    return cleanPersonaName(raw);
  } catch (error) {
    throw tableError(error.message.replace('A persona name', 'A friend\'s name').replace('A persona needs a name', 'A friend\'s name must be text'));
  }
}

function decisionRecap(entries) {
  return entries.map(({ street, label, think_ms: thinkMs, meta }) => ({
    street,
    label,
    think_ms: thinkMs,
    source: meta?.source ?? null,
    reason: meta?.reason ?? null,
    error: meta?.error ?? null,
    jev_choice: meta?.jev_choice ?? null,
    confidence: meta?.confidence ?? null,
    probabilities: meta?.probabilities ?? null,
    note: meta?.note ?? null,
    model: meta?.model ?? null,
    // An add-on bot's own decision details, passed through for its notes on the page.
    level: meta?.source === 'learner' ? meta.level ?? null : null,
    rule_choice: meta?.source === 'learner' ? meta.rule_choice ?? null : null,
    hand_strength: meta?.situation?.my_hand_strength ?? null,
    calling_on_the_numbers: meta?.situation?.calling_on_the_numbers ?? null
  }));
}

// The figures the page shows when a match is over.
function matchSummary(match, names) {
  const seats = match.players.map((player, seat) => {
    const actions = match.log.flatMap(hand => hand.actions.filter(action => action.seat === seat));
    const potsWon = match.log.flatMap(hand => hand.result.pots.filter(pot => pot.winners.includes(seat) && (pot.eligible.length > 1 || hand.result.reason === 'fold')).map(pot => pot.amount));
    return {
      seat,
      name: names[seat],
      net_chips: player.net_chips,
      final_stack: match.final_stacks[seat],
      hands_won: match.log.filter(hand => hand.result.winners.includes(seat)).length,
      biggest_pot_won: potsWon.length ? Math.max(...potsWon) : 0,
      decisions: actions.length,
      think_ms_total: player.think_ms_total,
      think_ms_mean: player.think_ms_mean,
      think_ms_max: player.think_ms_max,
      timeouts: actions.filter(action => action.meta?.reason === 'timeout').length,
      // Moves the rule bot played for this seat because its own player abstained or failed.
      stand_ins: actions.filter(action => action.meta?.source === 'fallback' && action.meta.reason !== 'timeout').length
    };
  });
  const biggest = match.log.reduce((best, hand) => (best === null || hand.result.pot > best.result.pot ? hand : best), null);
  return {
    seats,
    biggest_pot: biggest ? { amount: biggest.result.pot, hand_number: biggest.hand_number, winners: [...biggest.result.winners] } : null,
    showdowns: match.log.filter(hand => hand.result.reason === 'showdown').length
  };
}

/**
 * One table of two to six seats for a browser front end and for external agents. Seat 0 is drawn
 * nearest the viewer. Each seat holds one player type, optionally with a model name:
 *
 *   human  - the person at the page (seat 0 only)
 *   agent  - an open seat: an external agent reads `seatView(seat)` and answers `seatAct(seat, label)`
 *   other  - any id the injected `createPlayer(type, context)` can build (rule bot, Jev, a CLI model ...)
 *
 * The page snapshot shows a seat's cards only to a human sitting there, at showdown for players
 * who did not fold, or when no human is seated (spectator mode). An open seat's view never
 * contains another seat's cards. Every turn is timed; an optional limit plays a safe action.
 */
export function createTable({
  createPlayer,
  // The name the page shows. An add-on may give its edition another one.
  brand = 'OpenPoker',
  playerTypes,
  defaultPlayers = ['human', 'rule'],
  hands = 20,
  stack = 10_000,
  smallBlind = 50,
  bigBlind = 100,
  seed,
  botDelayMs = 650,
  turnLimitMs = 30_000,
  personaStore = null,
  gameHistory = null,
  learnerBoard = null,
  onMatchEnd = async () => null
}) {
  if (typeof createPlayer !== 'function') throw new TypeError('createTable requires createPlayer(type, context)');
  const listeners = new Set();
  const seatWaiters = new Set();
  let version = 0;
  let gameIndex = 0;
  let current = null;
  let lastTurnLimit = turnLimitMs;
  // One secret key per seat for friends' links. A seat keeps its key while the same friend sits there
  // ("Deal again" needs no new link) and gets a new one when anyone else does, so an old link opens nothing.
  const newSeatKey = () => randomBytes(24).toString('base64url');
  const seatKeys = Array.from({ length: MAX_SEATS }, newSeatKey);
  const seatOwners = Array.from({ length: MAX_SEATS }, () => null);
  function assignSeatKeys(types) {
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      const owner = types[seat]?.id === 'friend' ? `friend:${types[seat].friendName ?? ''}:${seat}` : null;
      if (owner !== seatOwners[seat] || owner === null) seatKeys[seat] = newSeatKey();
      seatOwners[seat] = owner;
    }
  }

  function notify() {
    version += 1;
    for (const listener of listeners) listener(version);
  }

  function wakeSeatWaiters() {
    for (const wake of [...seatWaiters]) wake();
  }

  // One seat: a player type id, or `{ type, model, reasoning, style, style_note }`.
  function validateSeat(spec, seat) {
    const type = typeof spec === 'string' ? spec : spec?.type;
    const model = typeof spec === 'object' && spec !== null && spec.model !== undefined && spec.model !== null && spec.model !== '' ? spec.model : null;
    const known = playerTypes.find(candidate => candidate.id === type);
    if (!known) throw tableError(`Unknown player type: ${String(type).slice(0, 40)}`);
    if (type === 'human' && seat !== 0) throw tableError('The human player sits in the bottom seat');
    if (!known.available) throw tableError(`${known.name} is not available: ${known.unavailable_reason || 'not configured'}`, 'PLAYER_UNAVAILABLE');
    if (model !== null) {
      if (!known.models) throw tableError(`${known.name} does not take a model`);
      // The model name reaches a command line or an API field, so only plain identifiers pass.
      if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) throw tableError('model must be 1 to 64 letters, digits, dots, colons, slashes, dashes or underscores, starting with a letter or digit');
    }
    const reasoning = typeof spec === 'object' && spec !== null && spec.reasoning !== undefined && spec.reasoning !== null ? spec.reasoning : null;
    if (reasoning !== null) {
      if (typeof reasoning !== 'boolean') throw tableError('reasoning must be true or false');
      if (!known.reasoning) throw tableError(`${known.name} does not have a reasoning switch`);
    }
    // A playing style: a preset for any type that takes styles, plus a free-text note for model seats.
    const styleId = typeof spec === 'object' && spec !== null && spec.style !== undefined && spec.style !== null && spec.style !== '' ? spec.style : null;
    const style = styleById(styleId);
    if (!style) throw tableError(`Unknown style: ${String(styleId).slice(0, 40)}`);
    if (style.id !== DEFAULT_STYLE && !known.styles) throw tableError(`${known.name} does not take a style`);
    const styleNote = cleanStyleNote(typeof spec === 'object' && spec !== null ? spec.style_note : null);
    if (styleNote && !known.style_notes) throw tableError(`${known.name} does not take a style note`);
    const friendName = type === 'friend' ? cleanFriendName(typeof spec === 'object' && spec !== null ? spec.name : null) : null;
    // A type with the switch reasons unless told otherwise; other types carry no setting.
    return { ...known, model, reasoning: known.reasoning ? reasoning !== false : null, style: known.styles ? style : null, styleNote, friendName };
  }

  function validatePlayers(specs) {
    if (!Array.isArray(specs) || specs.length < MIN_SEATS || specs.length > MAX_SEATS) {
      throw tableError(`players must list ${MIN_SEATS} to ${MAX_SEATS} seats, starting with the bottom seat`);
    }
    return specs.map((spec, seat) => validateSeat(spec, seat));
  }

  // A seat written as `{ persona: id }` is replaced by that saved persona's own seat.
  async function resolvePersonas(specs) {
    if (!Array.isArray(specs)) return { specs, personas: [] };
    const personas = [];
    const resolved = [];
    for (const [seat, spec] of specs.entries()) {
      const id = spec && typeof spec === 'object' ? spec.persona : undefined;
      if (id === undefined || id === null) {
        personas.push(null);
        resolved.push(spec);
        continue;
      }
      if (!personaStore) throw tableError('Personas are not enabled on this table');
      if (typeof id !== 'string') throw tableError('persona must be a persona id');
      if (personas.some(other => other?.id === id)) throw tableError('The same persona cannot sit in two seats');
      const persona = await personaStore.get(id);
      if (persona.type === 'human' && seat !== 0) throw tableError('A human persona sits in the bottom seat');
      personas.push({ id: persona.id, name: persona.name, rating: persona.rating });
      resolved.push({ type: persona.type, model: persona.model, reasoning: persona.reasoning, style: persona.style, style_note: persona.style_note });
    }
    return { specs: resolved, personas };
  }

  function validateTurnLimit(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MATCH_LIMITS.maxDecisionTimeoutMs) {
      throw tableError(`turn_limit_ms must be 0 (no limit) to ${MATCH_LIMITS.maxDecisionTimeoutMs}`);
    }
    return value;
  }

  function seatNames(types) {
    // A saved persona plays under its own name, which the store keeps unique.
    const taken = new Set(types.filter(type => type.persona).map(type => type.persona.name));
    const labels = types.map(type => (type.persona ? null : type.id === 'friend' ? (type.friendName ?? type.name) : `${type.name}${type.model ? ` · ${type.model}` : ''}${type.reasoning === false ? ' · fast' : ''}`));
    const seen = new Map();
    return labels.map((label, seat) => {
      if (label === null) return types[seat].persona.name;
      if (seat === 0 && types[0].id === 'human' && !taken.has('You')) return 'You';
      // Seats that would otherwise share a name, with each other or with a persona, are numbered.
      if (labels.filter(other => other === label).length === 1 && !taken.has(label)) return label;
      seen.set(label, (seen.get(label) || 0) + 1);
      return `${label} ${seen.get(label)}`;
    });
  }

  function startGame(types, builtPlayers, gameSeed, turnLimit) {
    const count = types.length;
    const seats = types.map((_, seat) => seat);
    const spectator = types[0].id !== 'human';
    const names = seatNames(types);
    const state = {
      status: 'starting',
      seed: gameSeed,
      spectator,
      turn_limit_ms: turnLimit,
      players: types.map((type, seat) => ({ seat, type: type.id, name: names[seat], persona: type.persona ? { ...type.persona } : null, model: type.model, reasoning: type.reasoning, style: type.style ? { id: type.style.id, name: type.style.name } : null, style_note: type.styleNote, think: { count: 0, total_ms: 0, mean_ms: null, max_ms: null, last_ms: null } })),
      hand: null,
      totals: { hands_played: 0, net: seats.map(() => 0) },
      warnings: [],
      match: null,
      error: null
    };
    // `hands` keeps each finished hand in the match log's own form, for the game history; `raw` is the hand being played.
    const game = { state, pending: null, seatPending: seats.map(() => null), seatLastResult: seats.map(() => null), aborted: false, closed: false, startedAt: Date.now(), hands: [], raw: null, shown: null, shownNames: null };
    // What a friend's own view needs: every seat's cards (only their own is shown) and the showdown.
    game.holeCards = () => holeCards;
    const changed = () => {
      if (current === game) notify();
    };
    let entries = seats.map(() => []);
    let holeCards = seats.map(() => null);
    // The odds shown to an open seat replay with the game's seed, like the deal.
    const seatRandom = seats.map(seat => seededRandom(gameSeed + 1 + seat));

    // Which cards the page may draw. `shown` is the engine's showdown reveal (null for folded seats).
    const visibleCards = shown => seats.map(seat => {
      if (!holeCards[seat]) return null;
      // A friend's cards stay theirs until a showdown, even when the owner is only watching.
      if (types[seat].id === 'friend') return shown?.[seat] ?? null;
      if (spectator || (seat === 0 && !spectator)) return holeCards[seat];
      return shown?.[seat] ?? null;
    });

    function warn(seat, message) {
      const text = `${names[seat]}: ${String(message).slice(0, 200)}`;
      if (!state.warnings.includes(text) && state.warnings.length < MAX_WARNINGS) state.warnings.push(text);
    }

    const human = {
      name: 'You',
      kind: 'human',
      decide(view, context) {
        return new Promise((resolve, reject) => {
          const hand = state.hand;
          hand.legal_actions = view.legal_actions.map(action => ({ ...action }));
          const pending = { kind: 'action', legal: hand.legal_actions, resolve, reject };
          game.pending = pending;
          // The turn clock ran out: a late click must not reach a turn that is already played.
          context?.signal?.addEventListener('abort', () => {
            if (game.pending === pending) game.pending = null;
            hand.legal_actions = [];
          }, { once: true });
          state.status = 'your_turn';
          changed();
        });
      }
    };

    // An open seat: the decision arrives from outside, like the human's.
    const openSeat = seat => ({
      name: names[seat],
      kind: types[seat].id,
      decide(view, context) {
        return new Promise(resolve => {
          const legal = view.legal_actions.map(action => ({ ...action }));
          const described = describeSituation(view, { random: seatRandom[seat], opponentProfile: context?.opponentProfile, opponentProfiles: context?.opponentProfiles });
          const pending = {
            view,
            legal,
            described,
            profiles: context?.opponentProfiles ?? null,
            finish(decision) {
              if (game.seatPending[seat] === pending) game.seatPending[seat] = null;
              resolve(decision);
            }
          };
          game.seatPending[seat] = pending;
          context?.signal?.addEventListener('abort', () => {
            if (game.seatPending[seat] === pending) game.seatPending[seat] = null;
          }, { once: true });
          wakeSeatWaiters();
          // A friend's page learns it is their turn from this change notice.
          if (types[seat].id === 'friend') changed();
        });
      }
    });

    const seated = types.map((type, seat) => {
      if (type.id === 'human') return human;
      // A friend's seat waits for its move the way an open seat does, but only through the friend's own link.
      return type.id === 'agent' || type.id === 'friend' ? openSeat(seat) : builtPlayers[seat];
    });

    // Every seat goes through this wrapper so a replaced game stops at its next decision.
    const players = seated.map((player, seat) => ({
      name: names[seat],
      kind: player.kind,
      async decide(view, context) {
        if (game.aborted) throw quit();
        const decision = await player.decide(view, context);
        if (game.aborted) throw quit();
        // A call the turn clock already cut off is a timeout, not a fault worth a notice.
        if (decision?.meta?.source === 'fallback' && decision.meta.error && !context?.signal?.aborted) warn(seat, decision.meta.error);
        return decision;
      }
    }));

    // Chips and bets as the acting seat sees them; this also picks up any unmatched bet returned by the engine.
    function syncChips(hand, view) {
      hand.pot = view.pot;
      hand.stacks[view.seat] = view.stack;
      hand.bets[view.seat] = view.committed;
      for (const opponent of view.opponents) {
        hand.stacks[opponent.seat] = opponent.stack;
        hand.bets[opponent.seat] = opponent.committed;
        hand.folded[opponent.seat] = !opponent.in_hand;
      }
      hand.all_in = seats.map(seat => hand.dealt_in[seat] && !hand.folded[seat] && hand.stacks[seat] === 0);
    }

    async function onEvent(event) {
      if (event.type === 'hand_start') {
        const views = event.views;
        entries = seats.map(() => []);
        holeCards = views.map(view => (view.hole_cards.length ? [...view.hole_cards] : null));
        game.shown = null;
        game.shownNames = null;
        game.raw = { hand_number: event.hand_number, button: event.button, starting_stacks: views.map(view => view.stack + view.committed), hole_cards: holeCards.map(cards => (cards ? [...cards] : null)), actions: [], board: [], result: null };
        const smallBlindSeat = views.findIndex(view => view.position === 'small blind' || view.position === 'button and small blind');
        state.hand = {
          number: event.hand_number,
          button_seat: event.button,
          small_blind_seat: smallBlindSeat,
          big_blind_seat: views.findIndex(view => view.position === 'big blind'),
          street: 'preflop',
          acting: null,
          turn_started_at: null,
          deadline: null,
          dealt_in: holeCards.map(Boolean),
          folded: seats.map(() => false),
          all_in: views.map((view, seat) => Boolean(holeCards[seat]) && view.stack === 0),
          cards: visibleCards(null),
          hand_names: seats.map(() => null),
          board: [],
          pot: views[0].pot,
          to_call: 0,
          stacks: views.map(view => view.stack),
          bets: views.map(view => view.committed),
          legal_actions: [],
          log: [],
          result: null,
          decisions: null
        };
        state.status = 'dealing';
      } else if (event.type === 'turn') {
        const hand = state.hand;
        const { seat, view } = event;
        syncChips(hand, view);
        hand.acting = seat;
        hand.to_call = view.to_call;
        hand.turn_started_at = Date.now();
        hand.deadline = event.deadline_ms ? hand.turn_started_at + event.deadline_ms : null;
        if (view.board.length >= 3 && (types[seat].id === 'human' || (spectator && types[seat].id !== 'friend'))) hand.hand_names[seat] = evaluateHand([...view.hole_cards, ...view.board]).name;
        state.status = 'thinking';
      } else if (event.type === 'action') {
        const hand = state.hand;
        const { seat, action } = event;
        const timedOut = event.meta?.reason === 'timeout';
        hand.log.push({ seat, street: action.street, label: action.label, amount: action.amount, to: action.to, think_ms: event.think_ms, timed_out: timedOut });
        // Taken from the engine, so a returned unmatched bet shows at once.
        hand.stacks = [...event.stacks];
        hand.bets = [...event.committed];
        hand.pot = event.pot;
        hand.folded = seats.map(other => hand.dealt_in[other] && !event.in_hand[other]);
        hand.all_in = seats.map(other => hand.dealt_in[other] && event.in_hand[other] && event.stacks[other] === 0);
        hand.legal_actions = [];
        hand.acting = null;
        hand.turn_started_at = null;
        hand.deadline = null;
        entries[seat].push({ street: action.street, label: action.label, think_ms: event.think_ms, meta: event.meta });
        game.raw?.actions.push({ street: action.street, seat, label: action.label, amount: action.amount, to: action.to, think_ms: event.think_ms, meta: event.meta });
        const think = state.players[seat].think;
        think.count += 1;
        think.total_ms += event.think_ms;
        think.mean_ms = Math.round(think.total_ms / think.count);
        think.max_ms = Math.max(think.max_ms ?? 0, event.think_ms);
        think.last_ms = event.think_ms;
        state.status = 'thinking';
        changed();
        // Hold an instant player's action on screen for a moment. This pause is not reasoning time.
        if (INSTANT_KINDS.has(seated[seat].kind)) await sleep(botDelayMs);
        return;
      } else if (event.type === 'street') {
        const hand = state.hand;
        hand.street = event.street;
        hand.board = [...event.board];
        hand.pot = event.pot;
        hand.bets = seats.map(() => 0);
      } else if (event.type === 'hand_end') {
        const { result } = event;
        const hand = state.hand;
        const shown = Boolean(result.shown_cards);
        hand.acting = null;
        hand.turn_started_at = null;
        hand.deadline = null;
        hand.board = [...result.board];
        hand.pot = result.pot;
        hand.bets = seats.map(() => 0);
        hand.stacks = [...result.stacks];
        hand.all_in = seats.map(() => false);
        hand.legal_actions = [];
        hand.cards = visibleCards(result.shown_cards);
        game.shown = result.shown_cards ? result.shown_cards.map(cards => (cards ? [...cards] : null)) : null;
        game.shownNames = result.shown_cards && result.hand_names ? [...result.hand_names] : null;
        if (shown) hand.hand_names = result.hand_names.map((name, seat) => (hand.cards[seat] ? name : null));
        hand.result = { reason: result.reason, winner: result.winner, winners: [...result.winners], pot: result.pot, pots: structuredClone(result.pots), net: [...result.net], showdown: shown };
        hand.decisions = seats.map(seat => (types[seat].id === 'human' || types[seat].id === 'friend' ? null : decisionRecap(entries[seat])));
        for (const seat of seats) {
          game.seatLastResult[seat] = {
            hand_number: hand.number,
            reason: result.reason,
            you_won: result.winners.includes(seat),
            winners: [...result.winners],
            pot: result.pot,
            your_net: result.net[seat],
            board: [...result.board],
            hand_names: shown ? [...result.hand_names] : null,
            // Cards of the players who reached the showdown; a folded hand is never revealed.
            shown_cards: shown ? result.shown_cards.map(cards => (cards ? [...cards] : null)) : null
          };
        }
        // A player that asks for it (an add-on bot) is told how each hand ended.
        for (const seat of seats) builtPlayers[seat]?.endHand?.({ finalStack: result.stacks[seat], bigBlind });
        if (game.raw) {
          game.hands.push({ ...game.raw, board: [...result.board], result: { reason: result.reason, winner: result.winner, winners: [...result.winners], pot: result.pot, pots: structuredClone(result.pots), net: [...result.net], hand_names: result.hand_names ? [...result.hand_names] : null } });
          game.raw = null;
        }
        state.totals.hands_played += 1;
        state.totals.net = state.totals.net.map((value, seat) => value + result.net[seat]);
        state.status = 'hand_over';
        changed();
        wakeSeatWaiters();
        // Hold the table until someone asks for the next hand.
        await new Promise(resolve => {
          game.pending = { kind: 'next', resolve };
        });
        game.pending = null;
        return;
      }
      changed();
    }

    game.finished = playMatch({ players, hands, stack, smallBlind, bigBlind, decisionTimeoutMs: turnLimit, random: seed === undefined ? secureRandom() : seededRandom(gameSeed), onEvent })
      .then(async match => {
        const saved = await onMatchEnd(match, { players: types.map(type => type.id), seats: types.map(type => ({ type: type.id, model: type.model, reasoning: type.reasoning, style: type.style?.id ?? null, style_note: type.styleNote })), seed: gameSeed });
        const most = Math.max(...match.final_stacks);
        const leaders = match.final_stacks.filter(chips => chips === most).length;
        // Every finished match with at least one hand moves the ratings of the personas who played it.
        let ratings = null;
        if (personaStore && match.hands_played > 0 && types.some(type => type.persona)) {
          const changes = await personaStore.recordMatch({
            hands: match.hands_played,
            big_blind: bigBlind,
            stop_reason: game.closed && match.stop_reason === 'player_quit' ? 'closed' : match.stop_reason,
            seats: match.players.map((player, seat) => ({ persona_id: types[seat].persona?.id ?? null, name: names[seat], net_chips: player.net_chips, decisions: player.decision_sources.decisions, think_ms_total: player.think_ms_total }))
          });
          ratings = changes.map((change, seat) => ({ seat, ...change })).filter(change => change.persona_id);
          for (const change of ratings) state.players[change.seat].persona.rating = change.after;
        }
        state.match = {
          stop_reason: game.closed && match.stop_reason === 'player_quit' ? 'closed' : match.stop_reason,
          hands_played: match.hands_played,
          duration_ms: Date.now() - game.startedAt,
          net: match.players.map(player => player.net_chips),
          final_stacks: [...match.final_stacks],
          winner_seat: match.hands_played && leaders === 1 ? match.final_stacks.indexOf(most) : null,
          log_path: saved?.json ?? null,
          summary: matchSummary(match, names),
          ratings
        };
        state.status = 'match_over';
        changed();
        wakeSeatWaiters();
      })
      .catch(error => {
        state.status = 'error';
        state.error = { code: error.code || 'JEV_ERROR', message: String(error.message || error).slice(0, 300) };
        changed();
        wakeSeatWaiters();
      })
      .finally(() => {
        // However the game ended, a player that keeps a tool session open between moves closes it now.
        for (const player of builtPlayers) {
          try {
            player?.close?.();
          } catch (error) {
            console.error(`A player could not close its session: ${error.message}`);
          }
        }
      });
    return game;
  }

  function abortCurrent() {
    const game = current;
    if (!game) return;
    game.aborted = true;
    const pending = game.pending;
    game.pending = null;
    if (pending?.kind === 'action') pending.reject(quit());
    else if (pending?.kind === 'next') pending.resolve();
    // The seat wrapper sees `aborted` and ends the match, whatever label arrives here.
    for (const seatPending of game.seatPending) seatPending?.finish({ label: 'fold', meta: { source: 'fallback', reason: 'stopped' } });
    wakeSeatWaiters();
  }

  function seatStatus(game, seat) {
    if (!game) return 'idle';
    if (game.state.players[seat]?.type !== 'agent') return 'seat_not_open';
    if (game.seatPending[seat]) return 'your_turn';
    if (game.state.status === 'match_over' || game.state.status === 'error') return 'match_over';
    return game.state.status === 'hand_over' ? 'hand_over' : 'waiting';
  }

  const running = game => Boolean(game) && !['match_over', 'error'].includes(game.state.status);

  // The running game in the form of a saved match log, so the history reads both the same way.
  function currentReport(game) {
    const { state } = game;
    return {
      run_id: 'current',
      in_progress: true,
      mode: 'web',
      started_at: new Date(game.startedAt).toISOString(),
      duration_ms: Date.now() - game.startedAt,
      hands_played: game.hands.length,
      seats: state.players.map(player => ({ type: player.type, model: player.model })),
      players: state.players.map(player => ({ name: player.name, kind: player.type, net_chips: state.totals.net[player.seat] })),
      blinds: { small: smallBlind, big: bigBlind },
      starting_stack: stack,
      decision_timeout_ms: state.turn_limit_ms,
      final_stacks: state.players.map(player => stack + state.totals.net[player.seat]),
      log: game.hands
    };
  }

  function checkSeat(seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) throw tableError(`seat must be 0 to ${MAX_SEATS - 1}`);
  }

  return {
    async newGame({ players = current?.state.players.map(player => (player.persona ? { persona: player.persona.id } : { type: player.type, model: player.model, reasoning: player.reasoning, style: player.style?.id ?? null, style_note: player.style_note })) ?? defaultPlayers, turnLimitMs: limit = lastTurnLimit } = {}) {
      const resolved = await resolvePersonas(players);
      const types = validatePlayers(resolved.specs).map((type, seat) => ({ ...type, persona: resolved.personas[seat] }));
      const turnLimit = validateTurnLimit(limit);
      const gameSeed = seed === undefined ? Math.floor(Math.random() * 2 ** 31) + 1 : seed + gameIndex;
      const built = await Promise.all(types.map((type, seat) => (
        type.id === 'human' || type.id === 'agent' || type.id === 'friend' ? null : createPlayer(type.id, { hands, seed: gameSeed, seat, model: type.model, reasoning: type.reasoning, style: type.style?.id ?? DEFAULT_STYLE, styleNote: type.styleNote, seats: types.length })
      )));
      abortCurrent();
      assignSeatKeys(types);
      gameIndex += 1;
      lastTurnLimit = turnLimit;
      current = startGame(types, built, gameSeed, turnLimit);
      // A friend's view numbers games with this instead of the seed, which would let the deck be rebuilt.
      current.index = gameIndex;
      notify();
      return this.snapshot();
    },

    act(label) {
      if (typeof label !== 'string') throw tableError('Action is not legal: an action is one of the legal labels', 'ILLEGAL_ACTION');
      const pending = current?.pending;
      if (pending?.kind !== 'action') throw tableError('It is not your turn', 'NOT_YOUR_TURN');
      if (!pending.legal.some(action => action.label === label)) throw tableError(`Action is not legal now: ${String(label).slice(0, 40)}`, 'ILLEGAL_ACTION');
      current.pending = null;
      current.state.hand.legal_actions = [];
      current.state.status = 'thinking';
      pending.resolve({ label, meta: { source: 'human' } });
      return this.snapshot();
    },

    next() {
      const pending = current?.pending;
      if (pending?.kind !== 'next') throw tableError('No finished hand is waiting', 'NOT_WAITING');
      current.state.status = 'dealing';
      pending.resolve();
      notify();
      return this.snapshot();
    },

    /** Ends the current game now. The hand in progress is abandoned and not counted. */
    async close() {
      const game = current;
      if (!game || ['match_over', 'error'].includes(game.state.status)) throw tableError('No game is running', 'NOT_RUNNING');
      game.closed = true;
      abortCurrent();
      await game.finished;
      notify();
      return this.snapshot();
    },

    async personas() {
      if (!personaStore) throw tableError('Personas are not enabled on this table', 'PERSONAS_DISABLED');
      return await personaStore.list();
    },

    async persona(id) {
      if (!personaStore) throw tableError('Personas are not enabled on this table', 'PERSONAS_DISABLED');
      return await personaStore.get(String(id));
    },

    /** Saves a named player. The seat it describes is checked exactly as a seat in a new game is. */
    async createPersona({ name, type, model = null, reasoning = null, style = null, style_note: styleNote = null } = {}) {
      if (!personaStore) throw tableError('Personas are not enabled on this table', 'PERSONAS_DISABLED');
      const seat = validateSeat({ type, model, reasoning, style, style_note: styleNote }, type === 'human' ? 0 : 1);
      return await personaStore.create({
        name,
        seat: { type: seat.id, model: seat.model, reasoning: seat.reasoning, style: seat.style && seat.style.id !== DEFAULT_STYLE ? seat.style.id : null, style_note: seat.styleNote }
      });
    },

    /** Saved games, newest first, and the game being played now while it runs. */
    async games() {
      if (!gameHistory) throw tableError('The game history is not enabled on this table', 'HISTORY_DISABLED');
      const games = await gameHistory.list();
      return { current: running(current) ? gameSummary(currentReport(current)) : null, games };
    },

    /** One game with every hand: a saved game by its id, or `current` for the game being played. */
    async game(id) {
      if (!gameHistory) throw tableError('The game history is not enabled on this table', 'HISTORY_DISABLED');
      if (id === 'current') {
        if (!running(current)) throw tableError('No game is being played', 'GAME_NOT_FOUND');
        return gameDetail(currentReport(current));
      }
      return await gameHistory.get(id);
    },

    /** The secret key in a seat's friend link. */
    seatKey(seat) {
      checkSeat(seat);
      return seatKeys[seat];
    },

    /** The seat a friend's key opens, or null. Compared in constant time, so timing says nothing about the keys. */
    seatForKey(key) {
      if (typeof key !== 'string' || key.length > 100) return null;
      const given = Buffer.from(key);
      let found = null;
      seatKeys.forEach((candidate, seat) => {
        const expected = Buffer.from(candidate);
        if (given.length === expected.length && timingSafeEqual(given, expected)) found = seat;
      });
      return found;
    },

    /** The friend seats of the current game, for the owner's invitations. */
    friendSeats() {
      return (current?.state.players ?? []).filter(player => player.type === 'friend').map(player => ({ seat: player.seat, name: player.name }));
    },

    /**
     * The table as a friend at `seat` may see it: their own cards, showdown cards, no one's
     * reasoning, and every seat turned so theirs is seat 0.
     */
    guestSnapshot(seat) {
      checkSeat(seat);
      const game = current;
      if (!game || game.state.players[seat]?.type !== 'friend') throw tableError('This link is not for a seat in the current game', 'SEAT_NOT_FRIEND');
      const view = this.snapshot();
      delete view.personas_enabled;
      // On a friend's page "You" is the friend; the person running the table is the Host.
      const host = name => (name === 'You' ? 'Host' : name);
      view.players = view.players.map(player => (player.type === 'human' ? { ...player, name: host(player.name) } : player));
      if (view.match?.summary?.seats) view.match.summary.seats = view.match.summary.seats.map(entry => ({ ...entry, name: host(entry.name) }));
      const hand = view.hand;
      if (hand) {
        const cards = game.holeCards();
        const shown = game.shown;
        hand.cards = view.players.map((_, other) => {
          if (other === seat) return cards[other] ? [...cards[other]] : null;
          return shown?.[other] ? [...shown[other]] : null;
        });
        hand.hand_names = view.players.map((_, other) => {
          if (shown) return hand.cards[other] ? game.shownNames?.[other] ?? null : null;
          return other === seat && cards[seat] && hand.board.length >= 3 ? evaluateHand([...cards[seat], ...hand.board]).name : null;
        });
        const pending = game.seatPending[seat];
        hand.legal_actions = pending ? pending.legal.map(action => ({ ...action })) : [];
        // Moves only: no hand strength, odds words or probabilities that would hint at a hidden hand.
        hand.decisions = Array.isArray(hand.decisions) ? hand.decisions.map(list => (Array.isArray(list) ? list.map(({ street, label, think_ms: thinkMs, source, reason, model }) => ({ street, label, think_ms: thinkMs, source, reason, model })) : list)) : hand.decisions;
      }
      view.status = game.seatPending[seat] ? 'your_turn' : view.status === 'your_turn' ? 'thinking' : view.status;
      view.spectator = false;
      // Nothing that is the host's alone: the deck's seed, notes to AI seats, errors on the host's computer, account details.
      view.seed = game.index;
      view.players = view.players.map(player => ({ ...player, style_note: null }));
      view.warnings = [];
      if (view.error) view.error = { code: view.error.code, message: 'The game stopped on an error at the host\'s computer.' };
      const seated = new Set(view.players.map(player => player.type));
      view.player_types = view.player_types.filter(type => seated.has(type.id)).map(({ id, name, category }) => ({ id, name, category, available: true, unavailable_reason: null, models: null, reasoning: false, styles: false, style_notes: false }));
      view.learner_enabled = false;
      if (view.match) delete view.match.log_path;
      // With no seat for the host, friends deal each next hand themselves.
      view.guest = { seat, name: game.state.players[seat].name, can_deal: game.state.spectator };
      return rotateSeats(view, seat);
    },

    /** A friend's move, from their own link. */
    friendAct(seat, label) {
      if (typeof label !== 'string') throw tableError('Action is not legal: an action is one of the legal labels', 'ILLEGAL_ACTION');
      checkSeat(seat);
      const game = current;
      if (!game || game.state.players[seat]?.type !== 'friend') throw tableError('This link is not for a seat in the current game', 'SEAT_NOT_FRIEND');
      const pending = game.seatPending[seat];
      if (!pending) throw tableError('It is not your turn', 'NOT_YOUR_TURN');
      if (!pending.legal.some(action => action.label === label)) throw tableError(`Action is not legal now: ${String(label).slice(0, 40)}`, 'ILLEGAL_ACTION');
      pending.finish({ label, meta: { source: 'friend' } });
      return this.guestSnapshot(seat);
    },

    /** A friend deals the next hand, only at a table where the host has no seat. A second press is ignored. */
    friendNext(seat) {
      checkSeat(seat);
      const game = current;
      if (!game || game.state.players[seat]?.type !== 'friend') throw tableError('This link is not for a seat in the current game', 'SEAT_NOT_FRIEND');
      if (!game.state.spectator) throw tableError('The host deals the next hand', 'HOST_DEALS');
      if (game.pending?.kind === 'next') this.next();
      return this.guestSnapshot(seat);
    },

    /** An add-on's dashboard: its list. */
    async learnerPolicies() {
      if (!learnerBoard) throw tableError('The Learner dashboard is not enabled on this table', 'LEARNER_DISABLED');
      return await learnerBoard.list();
    },

    /** An add-on's dashboard: one entry. */
    async learnerPolicy(name) {
      if (!learnerBoard) throw tableError('The Learner dashboard is not enabled on this table', 'LEARNER_DISABLED');
      return await learnerBoard.get(name);
    },

    async removePersona(id) {
      if (!personaStore) throw tableError('Personas are not enabled on this table', 'PERSONAS_DISABLED');
      if (running(current) && current.state.players.some(player => player.persona?.id === id)) throw tableError('That persona is playing in the current game', 'PERSONA_IN_USE');
      return await personaStore.remove(String(id));
    },

    snapshot() {
      const { turn_limit_ms: gameLimit, ...state } = current ? structuredClone(current.state) : { turn_limit_ms: lastTurnLimit, status: 'idle', seed: null, players: [], spectator: false, hand: null, totals: null, warnings: [], match: null, error: null };
      return {
        version,
        settings: { hands, stack, small_blind: smallBlind, big_blind: bigBlind, turn_limit_ms: gameLimit, max_seats: MAX_SEATS },
        personas_enabled: Boolean(personaStore),
        history_enabled: Boolean(gameHistory),
        learner_enabled: Boolean(learnerBoard),
        brand,
        styles: STYLES.map(({ id, name, description }) => ({ id, name, description })),
        player_types: playerTypes.map(({ id, name, category, available, unavailable_reason: reason, models, reasoning, styles, style_notes: notes, slow }) => ({ id, name, category: category ?? null, available, unavailable_reason: reason ?? null, models: models ? [...models] : null, reasoning: Boolean(reasoning), styles: Boolean(styles), style_notes: Boolean(notes), slow: Boolean(slow) })),
        ...state
      };
    },

    /** An open seat's own view. It never contains another seat's cards before a showdown. */
    seatView(seat) {
      checkSeat(seat);
      const game = current;
      const pending = game?.seatPending[seat] ?? null;
      const open = game?.state.players[seat]?.type === 'agent';
      return {
        schema_version: AGENT_SEAT_SCHEMA,
        seat,
        status: seatStatus(game, seat),
        hand_number: game?.state.hand?.number ?? null,
        // Only an open seat's own turn is shown here; a friend's seat (or a bot's) shows nothing of its cards.
        view: open && pending ? structuredClone(pending.view) : null,
        legal_actions: open && pending ? pending.legal.map(action => ({ ...action })) : [],
        // Convenience for agents that prefer words or ready-made odds to raw cards.
        situation: open && pending ? structuredClone(pending.described.state) : null,
        odds: open && pending ? { win_chance: Number(pending.described.facts.win_chance.toFixed(3)), price_to_call: Number(pending.described.facts.pot_odds.toFixed(3)), opponents_in: pending.described.facts.opponents_in } : null,
        opponent_profiles: open && pending?.profiles ? structuredClone(pending.profiles) : null,
        // The style the table owner asked this seat to play; an outside agent may follow it or not.
        style: open ? { ...(game.state.players[seat].style ?? { id: DEFAULT_STYLE, name: styleById(DEFAULT_STYLE).name }), description: styleById(game.state.players[seat].style?.id).description, note: game.state.players[seat].style_note } : null,
        // A seat that is not open to an agent reports nothing but its status.
        last_result: open && game.seatLastResult[seat] ? structuredClone(game.seatLastResult[seat]) : null,
        deadline: open && pending ? game.state.hand?.deadline ?? null : null,
        timeout_ms: game?.state.turn_limit_ms || null
      };
    },

    seatAct(seat, label, note) {
      if (typeof label !== 'string') throw tableError('Action is not legal: an action is one of the legal labels', 'ILLEGAL_ACTION');
      checkSeat(seat);
      const game = current;
      if (!game || game.state.players[seat]?.type !== 'agent') throw tableError(`Seat ${seat} is not open to an agent in this game`, 'SEAT_NOT_OPEN');
      const pending = game.seatPending[seat];
      if (!pending) throw tableError('It is not this seat\'s turn', 'NOT_YOUR_TURN');
      if (!pending.legal.some(action => action.label === label)) throw tableError(`Action is not legal now: ${String(label).slice(0, 40)}`, 'ILLEGAL_ACTION');
      // The note is untrusted text: it is stored and shown as plain text only, never interpreted.
      const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, MAX_NOTE_LENGTH) : null;
      pending.finish({ label, meta: { source: 'agent', note: cleanNote } });
      return this.seatView(seat);
    },

    /** Resolves when the open seat has something to do or see, or after `timeoutMs`. */
    waitForSeat(seat, timeoutMs) {
      checkSeat(seat);
      if (['your_turn', 'match_over', 'seat_not_open', 'idle'].includes(seatStatus(current, seat))) return Promise.resolve();
      return new Promise(resolve => {
        const done = () => {
          clearTimeout(timer);
          seatWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        seatWaiters.add(done);
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Resolves when the current match has finished and its log is written. */
    finished() {
      return current?.finished ?? Promise.resolve();
    },

    stop() {
      abortCurrent();
    }
  };
}
