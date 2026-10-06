import { describeSituation } from './describe.mjs';
import { DEFAULT_STYLE, styleById } from './styles.mjs';

// Configuration faults must stop the match; a transient failure should not.
const FATAL_DECISION_CODES = new Set(['MISSING_API_KEY', 'JEV_HTTP_401', 'JEV_HTTP_403', 'ATTEMPT_BUDGET_EXHAUSTED', 'INVALID_INPUT']);

const BALANCED_TUNING = styleById(DEFAULT_STYLE).tuning;

function styleOf(style) {
  const known = styleById(style);
  if (!known) throw new TypeError(`Unknown style: ${style}`);
  return known;
}

/** Pure odds: compare the chance of winning with the price of calling. Ignores the opponent's habits. */
export function ruleAction(facts, legalActions, tuning = BALANCED_TUNING) {
  const legal = new Set(legalActions.map(action => action.label));
  const first = (...labels) => labels.find(label => legal.has(label));
  const { equity, margin, to_call: toCall } = facts;
  // A style moves the bar for betting and raising, and how good the price must be for a call.
  const bar = base => base + tuning.raise_shift;
  if (toCall === 0) {
    if (equity >= bar(0.8)) return first('raise_large', 'raise_small', 'all_in', 'check');
    if (equity >= bar(0.62)) return first('raise_small', 'check');
    return 'check';
  }
  if (equity >= bar(0.85)) return first('raise_large', 'raise_small', 'all_in', 'call');
  if (equity >= bar(0.7) && margin > 0.1) return first('raise_small', 'call');
  if (margin >= tuning.call_margin) return 'call';
  return 'fold';
}

export function createRulePlayer({ name = 'Rule bot', random = Math.random, iterations = 400, style = DEFAULT_STYLE } = {}) {
  const { tuning } = styleOf(style);
  return {
    name,
    kind: 'rule',
    async decide(view) {
      const { facts } = describeSituation(view, { random, iterations });
      return { label: ruleAction(facts, view.legal_actions, tuning), meta: { source: 'rule', equity: Number(facts.equity.toFixed(3)) } };
    }
  };
}

/**
 * Jev picks among the legal labels; the rule bot plays whenever Jev abstains or fails.
 * `decide` is injected, for example `input => engine.runWorkflow('poker-decision', input)`.
 */
export function createJevPlayer({ name = 'Jev', decide, random = Math.random, iterations = 400, style = DEFAULT_STYLE } = {}) {
  if (typeof decide !== 'function') throw new TypeError('createJevPlayer requires a decide(input) function');
  const { tuning } = styleOf(style);
  return {
    name,
    kind: 'jev',
    async decide(view, { opponentProfile, opponentProfiles } = {}) {
      const { facts, state } = describeSituation(view, { random, iterations, opponentProfile, opponentProfiles });
      const labels = view.legal_actions.map(action => action.label);
      const fallback = ruleAction(facts, view.legal_actions, tuning);
      const base = { equity: Number(facts.equity.toFixed(3)), situation: state };
      if (labels.length === 1) return { label: labels[0], meta: { ...base, source: 'forced' } };
      let result;
      try {
        // The balanced style sends no style, so its request is the same as before styles existed.
        result = await decide({ situation: state, legal_actions: labels, ...(style === DEFAULT_STYLE ? {} : { style }) });
      } catch (error) {
        if (FATAL_DECISION_CODES.has(error.code)) throw error;
        // A label outside the legal list, or a malformed distribution, is rejected by the workflow.
        const reason = error.code === 'JEV_INVALID_RESPONSE' ? 'invalid_response' : 'error';
        return { label: fallback, meta: { ...base, source: 'fallback', reason, error_code: error.code || 'UNKNOWN' } };
      }
      const detail = {
        ...base,
        jev_choice: result.decision?.choice ?? null,
        confidence: result.decision?.confidence ?? null,
        probabilities: result.decision?.probabilities ?? null,
        latency_ms: result.latency_ms ?? null,
        input_tokens: result.usage?.input_tokens ?? null,
        // Recorded per decision: a larger table uses v2 wording and drops back to v1 when two players remain.
        question_version: result.question_version ?? null,
        model: result.model ?? null
      };
      if (result.abstained || !labels.includes(result.action)) {
        return { label: fallback, meta: { ...detail, source: 'fallback', reason: result.abstain_reason || 'invalid_response' } };
      }
      return { label: result.action, meta: { ...detail, source: 'jev', agrees_with_rule: result.action === fallback } };
    }
  };
}

const ACTION_HINTS = Object.freeze({
  fold: () => 'fold (give up the hand)',
  check: () => 'check (stay in for free)',
  call: action => `call (pay ${action.amount})`,
  raise_small: action => `raise_small (small bet or raise, to ${action.to})`,
  raise_large: action => `raise_large (large bet or raise, to ${action.to})`,
  all_in: action => `all_in (bet everything, to ${action.to})`
});

// The style a model seat is asked to play. The owner's note is quoted as data, not as an instruction to follow blindly.
function styleLines(style, styleNote) {
  const known = styleOf(style);
  const lines = [];
  if (known.id !== DEFAULT_STYLE) lines.push(`Your playing style: ${known.name}. ${known.description}`);
  if (styleNote) lines.push(`Style note from the table owner: "${styleNote}"`);
  if (lines.length) lines.push('Play in this style, but your whole reply must still be one legal label.');
  return lines;
}

/** Plain-text brief for a general model: the seat's own cards, the public facts, and the legal labels. */
export function buildAgentPrompt(view, described, { style = DEFAULT_STYLE, styleNote = null } = {}) {
  const who = action => (action.seat === view.seat ? 'you' : `seat ${action.seat}`);
  const history = view.actions.length
    ? view.actions.map(action => `${action.street}: ${who(action)} ${action.label}${action.amount ? ` (${action.amount} chips, total ${action.to})` : ''}`).join('; ')
    : 'none yet';
  const labels = view.legal_actions.map(action => action.label);
  const opponents = (view.opponents || []).map(opponent => {
    const status = !opponent.in_hand ? 'folded' : (opponent.all_in ? 'all-in' : `${opponent.stack} chips`);
    return `seat ${opponent.seat}${opponent.is_button ? ' (button)' : ''}: ${status}`;
  });
  const dealt = view.players_dealt_in ?? 2;
  const randomHands = described.facts.opponents_in === 1 ? 'one random hand' : `${described.facts.opponents_in} random hands`;
  return [
    `You are playing no-limit Texas Hold'em with play chips at a table of ${dealt} players. You are seat ${view.seat}${view.position && view.position !== 'other' ? ` (${view.position})` : ''}. It is your turn.`,
    `Your cards: ${view.hole_cards.join(' ')}`,
    `Board: ${view.board.length ? view.board.join(' ') : 'no cards yet'} (betting round: ${view.street})`,
    `Pot: ${view.pot}. To call: ${view.to_call}. Your chips: ${view.stack}. Big blind: ${view.big_blind}.`,
    `Opponents: ${opponents.length ? opponents.join('; ') : `one opponent with ${view.opponent_stack} chips`}.`,
    `Position: ${described.state.my_position}.`,
    `Actions so far this hand: ${history}.`,
    `Estimated chance of winning against ${randomHands}: ${Math.round(described.facts.win_chance * 100)}%. Calling costs ${Math.round(described.facts.pot_odds * 100)}% of the pot after the call.`,
    `Habits of the opponent who matters most: when raised, ${described.state.opponent_tendencies.when_raised}; raising, ${described.state.opponent_tendencies.how_often_they_raise}.`,
    ...styleLines(style, styleNote),
    `Legal actions: ${view.legal_actions.map(action => ACTION_HINTS[action.label](action)).join('; ')}.`,
    `Reply with exactly one of these labels and nothing else: ${labels.join(', ')}`
  ].join('\n');
}

/** First legal label named in a model's reply, or null. Longer labels are matched first. */
export function parseAgentLabel(text, labels) {
  // Compare as plain words so "raise-small", "Raise Small" and "raise_small" all match.
  const words = value => ` ${String(value ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `;
  const reply = words(text);
  let best = null;
  for (const label of labels) {
    const index = reply.indexOf(words(label));
    if (index >= 0 && (best === null || index < best.index || (index === best.index && label.length > best.label.length))) best = { label, index };
  }
  return best?.label ?? null;
}

/**
 * A player backed by a general model behind `ask(prompt) -> text` (or `{ text, model }`), for example a local Claude or
 * Codex command-line session. Code validates the reply; the rule bot plays when the model fails
 * or names no legal label.
 */
export function createModelPlayer({ name, kind = 'model', ask, random = Math.random, iterations = 400, style = DEFAULT_STYLE, styleNote = null } = {}) {
  if (typeof ask !== 'function') throw new TypeError('createModelPlayer requires an ask(prompt) function');
  const { tuning } = styleOf(style);
  return {
    name,
    kind,
    // Ends a session the model tool keeps open between moves, if it keeps one; the built-in tools do not.
    close() {
      ask.close?.();
    },
    async decide(view, { opponentProfile, opponentProfiles, signal } = {}) {
      const described = describeSituation(view, { random, iterations, opponentProfile, opponentProfiles });
      const labels = view.legal_actions.map(action => action.label);
      const fallback = ruleAction(described.facts, view.legal_actions, tuning);
      const base = { equity: Number(described.facts.equity.toFixed(3)) };
      if (labels.length === 1) return { label: labels[0], meta: { ...base, source: 'forced' } };
      const started = Date.now();
      let reply;
      try {
        reply = await ask(buildAgentPrompt(view, described, { style, styleNote }), { signal });
      } catch (error) {
        return { label: fallback, meta: { ...base, source: 'fallback', reason: 'error', error_code: error.code || 'UNKNOWN', error: String(error.message || error).slice(0, 200) } };
      }
      const text = typeof reply === 'object' && reply !== null ? reply.text : reply;
      const label = parseAgentLabel(text, labels);
      const detail = { ...base, latency_ms: Date.now() - started, reply: String(text ?? '').trim().slice(0, 120), model: (typeof reply === 'object' && reply?.model) || null };
      if (!label) return { label: fallback, meta: { ...detail, source: 'fallback', reason: 'invalid_response' } };
      return { label, meta: { ...detail, source: 'agent', agrees_with_rule: label === fallback } };
    }
  };
}

/** Plays a fixed list of labels, then checks or folds. For tests and scripted sessions. */
export function createScriptedPlayer(labels, { name = 'Script' } = {}) {
  const queue = [...labels];
  return {
    name,
    kind: 'scripted',
    async decide(view) {
      const legal = view.legal_actions.map(action => action.label);
      const wanted = queue.shift();
      if (legal.includes(wanted)) return { label: wanted, meta: { source: 'script' } };
      return { label: legal.includes('check') ? 'check' : 'fold', meta: { source: 'script' } };
    }
  };
}
