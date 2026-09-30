/**
 * Delivery hints from the api: "group G has news", "a Welcome is waiting".
 *
 * A hint is only a nudge to fetch now; nothing in it is trusted. While the
 * socket is up, polling can relax to a slow fallback, so a missed hint costs
 * latency, never data.
 */

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class Hints {
  constructor() {
    this.listeners = new Set();
    this.connected = false;
    this.closed = false;
    this.backoff = RECONNECT_MIN_MS;
  }

  /** fn(hint) for every hint; returns an unsubscribe function. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;
    try { ws = new WebSocket(`${proto}//${location.host}/api/live`); } catch { this.#retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.backoff = RECONNECT_MIN_MS; };
    ws.onmessage = (ev) => {
      let hint;
      try { hint = JSON.parse(ev.data); } catch { return; }
      for (const fn of this.listeners) fn(hint);
    };
    ws.onclose = (ev) => {
      this.connected = false;
      this.ws = null;
      // 4401/4403: this session can't listen (logged out, wrong origin).
      // Polling carries on regardless; don't hammer the server.
      if (ev.code === 4401 || ev.code === 4403) return;
      this.#retry(ev.code === 4429 ? RECONNECT_MAX_MS : undefined);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
  }

  #retry(delay) {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    const wait = delay ?? this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  close() {
    this.closed = true;
    this.connected = false;
    clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch { /* not open */ }
    this.ws = null;
    this.listeners.clear();
  }
}
