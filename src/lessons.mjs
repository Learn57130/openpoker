import { DEFAULT_STYLE, styleById } from './styles.mjs';

// Caps on the learning loop. A lesson is model text, so every one of these bounds what it can reach.
export const LESSON_LIMITS = Object.freeze({
  perReply: 3,
  length: 160,
  kept: 30,
  facts: 100,
  inPrompt: 8,
  promptChars: 1200,
  // A shorter match is mostly the deal; a lesson drawn from it would be noise.
  minHands: 5,
  reviewMs: 60_000,
  // The most hands described in one review, newest kept.
  reviewHands: 40
});

export const REVIEW_SYSTEM_PROMPT = 'You review your own play in a finished poker game with play chips. Write short lessons about your own decisions, one per line, in plain text. Do not use tools.';

const STREETS = Object.freeze(['preflop', 'flop', 'turn', 'river']);

/**
 * The leaderboard's name for a seat: its type and model, or a rule bot's style. A friend or an
 * open seat has none and plays as an unrated guest. Built from the type's own fields, never from
 * a list of type names.
 */
export function playerKey(type) {
  if (!type || type.id === 'friend' || type.id === 'agent') return null;
  if (type.id === 'human') return 'human';
  if (Array.isArray(type.models)) return `${type.id}:${type.model ?? 'default'}`;
  return `${type.id}:${type.style?.id ?? DEFAULT_STYLE}`;
}

/** How the leaderboard shows a key: "Claude · opus", "Bot · Rock", "You". */
export function playerKeyName(type) {
  if (type.id === 'human') return 'You';
  if (Array.isArray(type.models)) return `${type.name} · ${type.model ?? 'default'}`;
  return `${type.name} · ${type.style?.name ?? styleById(DEFAULT_STYLE).name}`;
}

/** Measured facts about one seat's play in a finished match, from the match record alone. */
export function gameFacts(match, seat, bigBlind) {
  const dealt = match.log.filter(hand => hand.hole_cards?.[seat]);
  const mine = hand => hand.actions.filter(action => action.seat === seat);
  const actions = dealt.flatMap(mine);
  const reachedShowdown = hand => hand.result.reason === 'showdown' && !mine(hand).some(action => action.label === 'fold');
  const showdowns = dealt.filter(reachedShowdown);
  const lost = dealt.filter(hand => hand.result.net[seat] < 0);
  const chipsLostByRound = Object.fromEntries(STREETS.map(street => [street, lost.reduce((total, hand) => total + mine(hand).filter(action => action.street === street).reduce((sum, action) => sum + (action.amount || 0), 0), 0)]));
  const worst = lost.reduce((best, hand) => (best === null || hand.result.net[seat] < best.result.net[seat] ? hand : best), null);
  const last = worst ? mine(worst).at(-1) : null;
  const judged = actions.filter(action => typeof action.meta?.agrees_with_rule === 'boolean');
  const net = match.players[seat].net_chips;
  return {
    hands_played: match.hands_played,
    hands_dealt_in: dealt.length,
    hands_won: dealt.filter(hand => hand.result.winners.includes(seat)).length,
    net_chips: net,
    net_big_blinds: Number((net / bigBlind).toFixed(1)),
    bb_per_100: match.hands_played ? Number((((net / bigBlind) / match.hands_played) * 100).toFixed(1)) : null,
    showdowns_won: showdowns.filter(hand => hand.result.winners.includes(seat)).length,
    showdowns_lost: showdowns.filter(hand => !hand.result.winners.includes(seat)).length,
    calls_lost_at_showdown: showdowns.filter(hand => !hand.result.winners.includes(seat) && mine(hand).some(action => action.label === 'call')).length,
    folds: actions.filter(action => action.label === 'fold').length,
    chips_lost_by_round: chipsLostByRound,
    biggest_loss: worst ? { hand_number: worst.hand_number, chips: -worst.result.net[seat], round: last?.street ?? null, last_action: last?.label ?? null } : null,
    moves: {
      model: actions.filter(action => action.meta?.source === 'agent').length,
      fallback: actions.filter(action => action.meta?.source === 'fallback' && action.meta.reason !== 'timeout').length,
      timeout: actions.filter(action => action.meta?.reason === 'timeout').length,
      forced: actions.filter(action => action.meta?.source === 'forced').length
    },
    same_as_rule: { agreed: judged.filter(action => action.meta.agrees_with_rule).length, of: judged.length }
  };
}

function factLines(facts) {
  const rounds = STREETS.map(street => `${street} ${facts.chips_lost_by_round[street]}`).join(', ');
  return [
    `Hands played: ${facts.hands_played}; dealt in: ${facts.hands_dealt_in}; won: ${facts.hands_won}.`,
    `Result: ${facts.net_chips >= 0 ? 'won' : 'lost'} ${Math.abs(facts.net_chips)} chips (${facts.net_big_blinds} big blinds, ${facts.bb_per_100 ?? 0} per 100 hands).`,
    `Showdowns won: ${facts.showdowns_won}; lost: ${facts.showdowns_lost}; lost after calling: ${facts.calls_lost_at_showdown}. Folds: ${facts.folds}.`,
    `Chips you put in during hands you lost, by betting round: ${rounds}.`,
    facts.biggest_loss ? `Biggest loss: hand ${facts.biggest_loss.hand_number}, ${facts.biggest_loss.chips} chips; your last action was ${facts.biggest_loss.last_action} on the ${facts.biggest_loss.round}.` : 'You lost no hand.',
    `Your moves: ${facts.moves.model} your own, ${facts.moves.fallback} replaced by the rule bot because a reply was unusable, ${facts.moves.timeout} timed out.`,
    facts.same_as_rule.of ? `You chose the same action as the simple rule bot ${facts.same_as_rule.agreed} times out of ${facts.same_as_rule.of}.` : null
  ].filter(Boolean);
}

/**
 * What a seat reads when it reviews its own match: the facts and its own hands. Other players'
 * cards are never included, shown or not, so nothing hidden can leak through a review.
 */
export function reviewPrompt({ match, seat, facts }) {
  const hands = match.log.filter(hand => hand.hole_cards?.[seat]).slice(-LESSON_LIMITS.reviewHands);
  const handLines = hands.map(hand => {
    const moves = hand.actions.filter(action => action.seat === seat).map(action => `${action.street} ${action.label}${action.amount ? ` ${action.amount}` : ''}`);
    const net = hand.result.net[seat];
    const outcome = net > 0 ? `won ${net}` : net < 0 ? `lost ${-net}` : 'broke even';
    const shown = hand.result.reason === 'showdown' && hand.result.hand_names?.[seat] ? ` with ${hand.result.hand_names[seat]}` : '';
    return `Hand ${hand.hand_number}: you held ${hand.hole_cards[seat].join(' ')}; board ${hand.board?.length ? hand.board.join(' ') : 'none'}; your moves: ${moves.length ? moves.join(', ') : 'none'}; ${outcome}${hand.result.reason === 'showdown' ? ` at a showdown${shown}` : ''}.`;
  });
  return [
    `You played a game of no-limit Texas Hold'em with play chips as seat ${seat}. The game is over. Here are the measured facts about your play, then your own hands.`,
    ...factLines(facts),
    `Your hands${hands.length < match.log.length ? ` (the latest ${hands.length})` : ''}:`,
    ...handLines,
    `Write at most ${LESSON_LIMITS.perReply} lessons about your own decisions that would help you play better in your next game. One lesson per line, each under ${LESSON_LIMITS.length} characters, plain text. Write nothing else.`
  ].join('\n');
}

/**
 * Lessons from a review reply. The reply is untrusted text: each lesson is one cleaned line of 1 to
 * `length` characters, a longer line is dropped rather than cut, and a lesson already in `existing`
 * (ignoring letter case) is skipped.
 */
export function parseLessons(text, existing = []) {
  const seen = new Set(existing.map(lesson => lesson.toLowerCase()));
  const lessons = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/^\s*(?:(?:[-*•]|\d{1,2}[.)])\s*)?(?:lesson\s*\d{0,2}\s*:\s*)?/i, '')
      .replace(/^["'“]+|["'”]+$/g, '')
      .trim();
    if (!line || line.length > LESSON_LIMITS.length || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    lessons.push(line);
    if (lessons.length === LESSON_LIMITS.perReply) break;
  }
  return lessons;
}

/** The newest lessons that fit in a prompt, newest first, within both caps. */
export function promptLessons(lessons) {
  const picked = [];
  let size = 0;
  for (const text of lessons) {
    if (picked.length === LESSON_LIMITS.inPrompt || size + text.length > LESSON_LIMITS.promptChars) break;
    picked.push(text);
    size += text.length;
  }
  return picked;
}
