import { DEFAULT_MODEL, TYPESAFE_ENDPOINT } from './constants.mjs';

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Jev request was aborted'), { code: 'ABORTED' }));
    }, { once: true });
  });
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 10_000);
  return Math.min(1000 * (2 ** attempt), 10_000);
}

export class AttemptBudget {
  constructor(maxAttempts) {
    this.maxAttempts = maxAttempts;
    this.used = 0;
  }

  take() {
    if (this.used >= this.maxAttempts) throw Object.assign(new Error('Jev attempt budget exhausted'), { code: 'ATTEMPT_BUDGET_EXHAUSTED' });
    this.used += 1;
    return this.used;
  }
}

export class TypeSafeClient {
  constructor({ apiKey, model = DEFAULT_MODEL, endpoint = TYPESAFE_ENDPOINT, fetchFn = fetch, requestTimeoutMs = 60_000, attemptBudget = new AttemptBudget(60) }) {
    if (!apiKey) throw Object.assign(new Error('TYPESAFE_API_KEY is required'), { code: 'MISSING_API_KEY' });
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
    this.fetchFn = fetchFn;
    this.requestTimeoutMs = requestTimeoutMs;
    this.attemptBudget = attemptBudget;
  }

  async ask(state, questions, { signal, retries = 1, onAttempt } = {}) {
    let callAttempts = 0;
    for (let retry = 0; retry <= retries; retry += 1) {
      this.attemptBudget.take();
      callAttempts += 1;
      await onAttempt?.({ attempt: callAttempts, retry, total_attempts_used: this.attemptBudget.used });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const started = performance.now();
      let response;
      try {
        response = await this.fetchFn(this.endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, state, questions }),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) throw Object.assign(new Error('Jev request timed out or was aborted'), { code: 'JEV_TIMEOUT' });
        throw Object.assign(new Error(`Jev request failed: ${error.message}`), { code: 'JEV_NETWORK_ERROR' });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
      const latencyMs = Math.round(performance.now() - started);
      if ([429, 529].includes(response.status) && retry < retries) {
        await sleep(retryDelay(response, retry), signal);
        continue;
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw Object.assign(new Error(`Jev returned non-JSON data with HTTP ${response.status}`), { code: 'JEV_INVALID_RESPONSE' });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`Jev returned HTTP ${response.status}`), { code: `JEV_HTTP_${response.status}` });
      }
      return { body, latency_ms: latencyMs, attempts_used: callAttempts, total_attempts_used: this.attemptBudget.used };
    }
    throw new Error('Unreachable retry state');
  }
}
