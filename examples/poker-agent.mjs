#!/usr/bin/env node
// Example agent for an open seat at the local poker table.
//
//   openpoker --web --players you,agent     (or pick "Open seat" in the page)
//   node examples/poker-agent.mjs [--url http://127.0.0.1:8787] [--seat 1]     (seats are 0 to 5)
//
// The loop below is the whole protocol: long-poll the seat's own view, then answer a turn with
// one label. `choose` is where you would plug in your own model. Hand it `seatView.view` (your
// cards, the board, the bets, `view.opponents`), `seatView.situation` (the same in words) or
// `seatView.odds` (against every opponent still in), and return one label from
// `seatView.legal_actions` plus a short note.
//
// The server validates every label: one that is not legal now is refused (HTTP 400) and the turn
// stays open, and a turn left unanswered past `deadline` (`timeout_ms` after it began) is played
// as a check or a fold. Read only `/seats/N/view`; it never holds another seat's cards before a
// showdown, and never a folded hand.

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = String(option('--url', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const seat = Number(option('--seat', 1));
if (!Number.isInteger(seat) || seat < 0 || seat > 5) {
  console.error('--seat must be 0 (bottom seat) to 5, counted clockwise');
  process.exit(2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percent = value => `${Math.round(value * 100)}%`;

/** A simple readable policy: compare the chance of winning with the price of calling. */
function choose({ odds, legal_actions: legal }) {
  const labels = new Set(legal.map(action => action.label));
  const first = (...wanted) => wanted.find(label => labels.has(label));
  const { win_chance: win, price_to_call: price } = odds;
  if (labels.has('check')) {
    // Nothing to call: bet the strong hands, otherwise take the free card.
    if (win >= 0.8) return { label: first('raise_large', 'raise_small', 'all_in', 'check'), note: `${percent(win)} to win, free to act: large bet` };
    if (win >= 0.62) return { label: first('raise_small', 'check'), note: `${percent(win)} to win, free to act: small bet` };
    return { label: 'check', note: `${percent(win)} to win, free to act: check` };
  }
  const numbers = `${percent(win)} to win against a price of ${percent(price)}`;
  if (win >= 0.85) return { label: first('raise_large', 'raise_small', 'all_in', 'call'), note: `${numbers}: raise` };
  if (win - price >= 0.03) return { label: 'call', note: `${numbers}: call` };
  return { label: 'fold', note: `${numbers}: fold` };
}

async function request(path, body) {
  const response = await fetch(`${base}${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { refused: true });
  return data;
}

async function main() {
  let hinted = false;
  console.log(`Playing seat ${seat} at ${base}`);
  for (;;) {
    const seatView = await request(`/seats/${seat}/view?wait=20000`);
    if (seatView.status === 'match_over') {
      console.log('Match over.');
      return;
    }
    if (seatView.status === 'seat_not_open' || seatView.status === 'idle') {
      if (!hinted) console.log(`Seat ${seat} is not open: start the table with --players you,agent or pick Open seat in the page`);
      hinted = true;
      await sleep(2000);
      continue;
    }
    hinted = false;
    // `waiting` and `hand_over` need no answer: the long poll returns again when there is a turn.
    if (seatView.status !== 'your_turn') continue;
    const { label, note } = choose(seatView);
    try {
      await request(`/seats/${seat}/action`, { label, note });
      console.log(`hand ${seatView.hand_number} ${seatView.view.street}: ${label} (${note})`);
    } catch (error) {
      if (!error.refused) throw error;
      console.log(`hand ${seatView.hand_number}: ${label} was refused (${error.message})`);
    }
  }
}

main().catch(error => {
  console.error(`Could not reach the table at ${base}: ${error.cause?.code || error.cause?.message || error.message}. Is \`openpoker --web\` running?`);
  process.exit(1);
});
