export function validateChoice(answer, allowedValues, name) {
  const allowed = allowedValues instanceof Set ? allowedValues : new Set(allowedValues);
  if (!answer || answer.type !== 'choice' || !allowed.has(answer.choice)) {
    throw Object.assign(new Error(`Jev returned an invalid ${name} answer`), { code: 'JEV_INVALID_RESPONSE' });
  }
  if (!answer.probabilities || typeof answer.probabilities !== 'object') {
    throw Object.assign(new Error(`Jev omitted ${name} probabilities`), { code: 'JEV_INVALID_RESPONSE' });
  }
  const probabilities = {};
  for (const key of allowed) {
    const value = Number(answer.probabilities[key] ?? 0);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw Object.assign(new Error(`Jev returned invalid ${name} probabilities`), { code: 'JEV_INVALID_RESPONSE' });
    }
    probabilities[key] = value;
  }
  const confidence = Number(answer.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw Object.assign(new Error(`Jev returned invalid ${name} confidence`), { code: 'JEV_INVALID_RESPONSE' });
  }
  return { type: 'choice', choice: answer.choice, probabilities, confidence };
}

export async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await operation(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
