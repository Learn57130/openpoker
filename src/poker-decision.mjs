import { POKER_MULTIWAY_QUESTION_VERSION, POKER_STYLE_VERSION, POKER_POLICY_VERSION, POKER_QUESTION_VERSION } from './constants.mjs';
import { validateChoice } from './lib/judgments.mjs';

export const POKER_ACTION_LABELS = Object.freeze(['fold', 'check', 'call', 'raise_small', 'raise_large', 'all_in']);
export const POKER_MIN_CONFIDENCE = 0.5;

// The decision rule is written into each option: Jev follows a stated rule but does not derive one.
const CRITERIA = Object.freeze({
  fold: 'Give up the hand. Choose this when `calling_on_the_numbers` is "not worth it", or when the hand is weak and the price is expensive.',
  check: 'Stay in the hand without betting. Choose this when nothing needs to be called and the hand is very weak, weak or medium.',
  call: 'Match the opponent\'s bet without raising. Choose this when `calling_on_the_numbers` is worth it or about break-even and the hand is not strong enough to raise.',
  raise_small: 'Make a small bet or raise. Choose this with a strong hand, or with a medium hand when the opponent folds often when raised.',
  raise_large: 'Make a large bet or raise. Choose this with a very strong hand, especially when the opponent rarely folds.',
  all_in: 'Bet every remaining chip. Choose this only with a very strong hand when `stack_depth` is short.',
  unclear: 'The description does not give enough information to choose an action.'
});

// v2: the same rule for a table of more than two players. It is used when the situation names how
// many opponents are still in; the two-player wording above stays as v1 so earlier runs compare.
const MULTIWAY_CRITERIA = Object.freeze({
  ...CRITERIA,
  call: 'Match the current bet without raising. Choose this when `calling_on_the_numbers` is worth it or about break-even and the hand is not strong enough to raise.',
  raise_small: 'Make a small bet or raise. Choose this with a strong hand, or with a medium hand when only one opponent is still in and that opponent folds often when raised.',
  raise_large: 'Make a large bet or raise. Choose this with a very strong hand, and prefer it to a small raise when two or more opponents are still in.'
});
// A style is a different written rule. Jev follows the rule it is given, so each playing style
// replaces the options' wording; the balanced style keeps the wording above unchanged.
export const POKER_STYLE_CRITERIA = Object.freeze({
  tight_aggressive: Object.freeze({
    fold: 'Give up the hand. Choose this when something must be called and `calling_on_the_numbers` is anything less than "clearly worth it", unless the hand is strong or very strong.',
    check: 'Stay in the hand without betting. Choose this when nothing needs to be called and the hand is very weak or weak.',
    call: 'Match the current bet without raising. Choose this only when `calling_on_the_numbers` is "clearly worth it" and the hand is medium.',
    raise_small: 'Make a small bet or raise. Choose this with a medium hand when nothing needs to be called, or with a strong hand when something must be called.',
    raise_large: 'Make a large bet or raise. Choose this with a strong hand when nothing needs to be called, and always with a very strong hand.'
  }),
  loose_aggressive: Object.freeze({
    fold: 'Give up the hand. Choose this only when the hand is very weak and `calling_on_the_numbers` is "not worth it". Do not choose this with a weak, medium, strong or very strong hand.',
    check: 'Stay in the hand without betting. Choose this only with a very weak hand when nothing needs to be called. Do not choose this with a weak, medium, strong or very strong hand.',
    call: 'Match the current bet without raising. Choose this when something must be called and the hand is weak or medium, even when `calling_on_the_numbers` is "not worth it".',
    raise_small: 'Make a small bet or raise. Choose this with a weak or medium hand when nothing needs to be called, as a bluff or a thin bet, and with a strong hand when something must be called.',
    raise_large: 'Make a large bet or raise. Choose this with a strong hand when nothing needs to be called, and always with a very strong hand.'
  }),
  tight_passive: Object.freeze({
    fold: 'Give up the hand. Choose this when `calling_on_the_numbers` is "not worth it" or "about break-even", or when the opponent made a large raise and the hand is not very strong.',
    check: 'Stay in the hand without betting. Choose this whenever nothing needs to be called and the hand is very weak, weak, medium or strong.',
    call: 'Match the current bet without raising. Choose this when `calling_on_the_numbers` is "clearly worth it" or "slightly worth it" and the hand is medium, strong or very strong.',
    raise_small: 'Make a small bet or raise. Choose this only with a very strong hand when nothing needs to be called. Never choose this with a strong, medium or weak hand.',
    raise_large: 'Make a large bet or raise. Almost never choose this.'
  }),
  loose_passive: Object.freeze({
    fold: 'Give up the hand. Choose this only when the hand is very weak and the price is expensive or very expensive. Do not choose this with a weak, medium, strong or very strong hand.',
    check: 'Stay in the hand without betting. Choose this whenever nothing needs to be called and the hand is very weak, weak, medium or strong.',
    call: 'Match the current bet without raising. Choose this whenever something must be called and the hand is weak, medium, strong or very strong, even when `calling_on_the_numbers` is "not worth it" and even when the price is expensive. Also choose this with a very weak hand when the price is cheap or fair.',
    raise_small: 'Make a small bet or raise. Choose this only with a very strong hand when nothing needs to be called. Never choose this with a strong, medium or weak hand.',
    raise_large: 'Make a large bet or raise. Almost never choose this.'
  })
});

const INSTRUCTIONS = 'It is my turn in a two-player poker hand. Based on `my_hand_strength`, `price_to_call`, `calling_on_the_numbers` and what the opponent did, which single action should I take now?';
const MULTIWAY_INSTRUCTIONS = 'It is my turn in a poker hand at a table of several players. Based on `my_hand_strength`, `price_to_call`, `calling_on_the_numbers`, `opponents_still_in` and what the opponents did, which single action should I take now?';

function usageError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_INPUT' });
}

function boundedText(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw usageError(`${name} must be a short non-empty string`);
  return value;
}

export function normalizePokerDecisionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw usageError('poker-decision input must be an object');
  const labels = input.legal_actions;
  if (!Array.isArray(labels) || labels.length < 1 || labels.length > POKER_ACTION_LABELS.length) throw usageError('legal_actions must list one to six action labels');
  if (new Set(labels).size !== labels.length || labels.some(label => !POKER_ACTION_LABELS.includes(label))) {
    throw usageError(`legal_actions may contain only: ${POKER_ACTION_LABELS.join(', ')}`);
  }
  const source = input.situation;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw usageError('situation must be an object of described facts');
  const entries = Object.entries(source);
  if (entries.length < 1 || entries.length > 16) throw usageError('situation must have one to sixteen fields');
  const situation = {};
  for (const [key, value] of entries) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = Object.entries(value);
      if (nested.length > 8) throw usageError(`situation.${key} has too many fields`);
      situation[key] = Object.fromEntries(nested.map(([innerKey, innerValue]) => [innerKey, boundedText(innerValue, `situation.${key}.${innerKey}`)]));
    } else {
      situation[key] = boundedText(value, `situation.${key}`);
    }
  }
  const style = input.style ?? null;
  if (style !== null && style !== 'balanced' && !Object.hasOwn(POKER_STYLE_CRITERIA, style)) {
    throw usageError(`style must be one of: balanced, ${Object.keys(POKER_STYLE_CRITERIA).join(', ')}`);
  }
  return { situation, legal_actions: [...labels], style: style === 'balanced' ? null : style };
}

export function buildPokerDecisionQuestion(legalActions, { multiway = false, style = null } = {}) {
  const rubric = { ...(multiway ? MULTIWAY_CRITERIA : CRITERIA), ...(style ? POKER_STYLE_CRITERIA[style] : {}) };
  const criteria = Object.fromEntries([...legalActions, 'unclear'].map(label => [label, rubric[label]]));
  return {
    action: {
      type: 'choice',
      instructions: multiway ? MULTIWAY_INSTRUCTIONS : INSTRUCTIONS,
      criteria
    }
  };
}

export async function runPokerDecision({ input, client }) {
  const request = normalizePokerDecisionInput(input);
  const allowed = [...request.legal_actions, 'unclear'];
  const startedAt = performance.now();
  const multiway = typeof request.situation.opponents_still_in === 'string';
  const response = await client.ask(request.situation, buildPokerDecisionQuestion(request.legal_actions, { multiway, style: request.style }), { retries: 1 });
  const decision = validateChoice(response.body?.answers?.action, allowed, 'poker action');
  let reason = null;
  if (decision.choice === 'unclear') reason = 'unclear';
  else if (decision.confidence < POKER_MIN_CONFIDENCE) reason = 'low_confidence';
  return {
    schema_version: 'jev/run/v1',
    status: 'complete',
    workflow: 'poker-decision',
    // The workflow only returns a label; it has no side effect to run live.
    mode: 'shadow',
    request,
    question_version: multiway ? POKER_MULTIWAY_QUESTION_VERSION : POKER_QUESTION_VERSION,
    policy_version: POKER_POLICY_VERSION,
    style: request.style ?? 'balanced',
    style_version: request.style ? POKER_STYLE_VERSION : null,
    decision,
    action: reason ? null : decision.choice,
    abstained: Boolean(reason),
    abstain_reason: reason,
    model: response.body?.model ?? null,
    usage: response.body?.usage ?? null,
    latency_ms: response.latency_ms ?? null,
    duration_ms: Math.round(performance.now() - startedAt),
    attempts_used: client.attemptBudget?.used ?? null
  };
}

export const pokerDecisionWorkflow = Object.freeze({
  name: 'poker-decision',
  version: '1.0.0',
  description: 'Choose one code-listed legal poker action from a described situation, or abstain.',
  async run({ client, input }) {
    return await runPokerDecision({ input, client });
  }
});
