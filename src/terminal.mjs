import readline from 'node:readline';
import { formatCard } from './cards.mjs';

const KEYS = Object.freeze({ f: 'fold', k: 'check', c: 'call', s: 'raise_small', l: 'raise_large', a: 'all_in' });
const KEY_BY_LABEL = Object.freeze(Object.fromEntries(Object.entries(KEYS).map(([key, label]) => [label, key])));
const STREET_TITLES = Object.freeze({ flop: 'Flop', turn: 'Turn', river: 'River' });

function cards(list) {
  return list.map(formatCard).join(' ');
}

// Reads whole lines and reports end of input as null, so a closed terminal or pipe ends the match cleanly.
function createLineReader(input) {
  const lines = [];
  const waiting = [];
  let closed = false;
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  reader.on('line', line => (waiting.length ? waiting.shift()(line) : lines.push(line)));
  reader.on('close', () => {
    closed = true;
    while (waiting.length) waiting.shift()(null);
  });
  return {
    next: () => new Promise(resolve => {
      if (lines.length) resolve(lines.shift());
      else if (closed) resolve(null);
      else waiting.push(resolve);
    }),
    close: () => reader.close()
  };
}

function optionText(action, streetHigh) {
  const key = `[${KEY_BY_LABEL[action.label]}]`;
  if (action.label === 'fold') return `${key} fold`;
  if (action.label === 'check') return `${key} check`;
  if (action.label === 'call') return `${key} call ${action.amount}`;
  if (action.label === 'all_in') return `${key} all-in (${action.to})`;
  return `${key} ${streetHigh === 0 ? 'bet' : 'raise to'} ${action.to}`;
}

function actionText(name, action, streetHigh) {
  const verb = name === 'You' ? word => word : word => `${word}s`;
  if (action.label === 'fold') return `${name} ${verb('fold')}.`;
  if (action.label === 'check') return `${name} ${verb('check')}.`;
  if (action.label === 'call') return `${name} ${verb('call')} ${action.amount}.`;
  if (action.label === 'all_in') return `${name} ${name === 'You' ? 'go' : 'goes'} all-in (${action.to}).`;
  return streetHigh === 0 ? `${name} ${verb('bet')} ${action.to}.` : `${name} ${verb('raise')} to ${action.to}.`;
}

function recapLine(name, decisions) {
  if (!decisions.length) return null;
  const parts = decisions.map(({ street, label, meta }) => {
    if (meta?.source === 'jev') return `${street} ${label} (confidence ${Number(meta.confidence).toFixed(2)})`;
    if (meta?.source === 'fallback') return `${street} ${label} (rule bot stepped in: ${meta.reason})`;
    return `${street} ${label}`;
  });
  return `${name}'s decisions: ${parts.join(' · ')}`;
}

/**
 * Terminal front end for one human seat. It prints only that seat's view; the opponent's cards
 * appear only when the engine reveals them at showdown.
 */
export function createTerminalGame({ input, output, humanSeat = 0, opponentName = 'Bot', showDecisions = false }) {
  const reader = createLineReader(input);
  const write = text => output.write(`${text}\n`);
  const nameOf = seat => (seat === humanSeat ? 'You' : opponentName);
  let streetHigh = 0;
  let opponentDecisions = [];

  const player = {
    name: 'You',
    kind: 'human',
    async decide(view) {
      const legal = view.legal_actions;
      write(`  Pot ${view.pot} · to call ${view.to_call} · your chips ${view.stack}`);
      while (true) {
        output.write(`  Your move: ${legal.map(action => optionText(action, streetHigh)).join('  ')}  [q] quit > `);
        const line = await reader.next();
        if (line === null) {
          write('');
          throw Object.assign(new Error('Input closed'), { code: 'PLAYER_QUIT' });
        }
        const typed = line.trim().toLowerCase();
        if (typed === 'q' || typed === 'quit') throw Object.assign(new Error('Player quit'), { code: 'PLAYER_QUIT' });
        const label = KEYS[typed] || typed;
        if (legal.some(action => action.label === label)) return { label, meta: { source: 'human' } };
        write('  Not available now. Type one of the letters in brackets.');
      }
    }
  };

  function onEvent(event) {
    if (event.type === 'hand_start') {
      const view = event.views[humanSeat];
      streetHigh = view.big_blind;
      opponentDecisions = [];
      write('');
      write(`── Hand ${event.hand_number} ──  You ${event.stacks[humanSeat]} chips · ${opponentName} ${event.stacks[1 - humanSeat]} chips`);
      write(view.is_button ? '  You are the button: you post the small blind and act first before the flop.' : `  ${opponentName} is the button: you post the big blind.`);
      write(`  Your cards: ${cards(view.hole_cards)}`);
    } else if (event.type === 'action') {
      write(`  ${actionText(nameOf(event.seat), event.action, streetHigh)}`);
      streetHigh = Math.max(streetHigh, event.action.to);
      if (event.seat !== humanSeat) opponentDecisions.push({ street: event.action.street, label: event.action.label, meta: event.meta });
    } else if (event.type === 'street') {
      streetHigh = 0;
      write(`  ${STREET_TITLES[event.street]}: ${cards(event.board)}   (pot ${event.pot})`);
    } else if (event.type === 'hand_end') {
      const { result } = event;
      if (result.reason === 'showdown') {
        write(`  Showdown. Board: ${cards(result.board)}`);
        write(`  You: ${cards(result.shown_cards[humanSeat])} (${result.hand_names[humanSeat]}) · ${opponentName}: ${cards(result.shown_cards[1 - humanSeat])} (${result.hand_names[1 - humanSeat]})`);
      }
      const net = result.net[humanSeat];
      if (result.winner === null) write(`  Split pot of ${result.pot}.`);
      else if (result.winner === humanSeat) write(`  You win the pot of ${result.pot} (+${net}).`);
      else write(`  ${opponentName} wins the pot of ${result.pot} (you lose ${-net}).`);
      const recap = showDecisions ? recapLine(opponentName, opponentDecisions) : null;
      if (recap) write(`  ${recap}`);
    }
  }

  return { player, onEvent, close: () => reader.close() };
}
