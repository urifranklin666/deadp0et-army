/**
 * Live cursors over an ephemeral relay.
 *
 * Frames are sealed with a key derived from the MLS exporter, so the server
 * relays bytes it cannot read and stores none of them. Deliberately NOT MLS
 * application messages: at pointer rates those would flood the ordered log
 * and consume ratchet generations faster than peers keep skipped keys.
 */

const SEND_HZ = 20;
const STALE_MS = 5000;          // no frame for this long => cursor disappears
const RECONNECT_MS = 2000;

export class Presence {
  constructor(session) {
    this.session = session;
    this.peers = new Map();      // id -> { x, y, handle, at }
    this.onChange = null;
    this.ws = null;
    this.closed = false;
    this.lastSent = 0;
    this.pending = null;
    this.id = Math.random().toString(36).slice(2, 10);
  }

  connect() {
    if (this.closed || !this.session.client || !this.session.groupId) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/mls/groups/${encodeURIComponent(this.session.groupId)}/live`;

    let ws;
    try { ws = new WebSocket(url); } catch { this.#retry(); return; }
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onmessage = async (ev) => {
      const packet = await this.session.client.openPresence(new Uint8Array(ev.data)).catch(() => null);
      // Null means a different epoch or a frame not meant for us — ignore.
      if (!packet || !packet.id || packet.id === this.id) return;
      this.peers.set(packet.id, { x: packet.x, y: packet.y, handle: packet.h, at: Date.now() });
      this.onChange?.();
    };
    ws.onclose = (ev) => {
      this.ws = null;
      // 4403: the server says this session may not listen here (logged out,
      // or no longer a member). Retrying every two seconds would only hammer
      // it; a fresh Presence is created when the channel is reopened.
      if (ev.code === 4403) { this.close(); return; }
      this.#retry();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };

    this.sweeper ??= setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, p] of this.peers) {
        if (now - p.at > STALE_MS) { this.peers.delete(id); changed = true; }
      }
      if (changed) this.onChange?.();
    }, 1000);
  }

  #retry() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), RECONNECT_MS);
  }

  /** Throttled cursor publish; coordinates are normalised 0..1. */
  move(x, y) {
    this.pending = { x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4 };
    const now = Date.now();
    if (now - this.lastSent < 1000 / SEND_HZ) return;
    this.lastSent = now;
    this.#flush();
  }

  async #flush() {
    const p = this.pending;
    if (!p || !this.ws || this.ws.readyState !== 1 || !this.session.client) return;
    try {
      const sealed = await this.session.client.sealPresence({
        id: this.id, h: this.session.handle, x: p.x, y: p.y,
      });
      if (this.ws?.readyState === 1) this.ws.send(sealed);
    } catch { /* epoch changed mid-flight; the next frame carries the new key */ }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.sweeper);
    this.sweeper = null;
    try { this.ws?.close(); } catch { /* not open */ }
    this.ws = null;
    this.peers.clear();
  }
}
