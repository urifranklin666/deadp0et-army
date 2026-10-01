import React, { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Palette, PenLine, Trash2, Undo2 } from "lucide-react";
import { Presence } from "./lib/presence.js";

/**
 * Collaborative canvas over the group's Yjs document.
 *
 * Strokes live in a Y.Array so concurrent drawing merges without a server
 * arbitrating. Each committed stroke is one MLS application message,
 * encrypted once for the whole room — the reason this sits on MLS rather
 * than pairwise sessions, which would need one ciphertext per recipient
 * device per stroke.
 */

const COLORS = ["#fb3b53", "#0ea5c4", "#e879f9", "#fbbf24", "#e2e8f0"];
const WIDTHS = [2, 4, 8, 16];

export default function Canvas({ session, onError, openModal }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [erasing, setErasing] = useState(false);
  const [count, setCount] = useState(session.strokes.length);
  const drawing = useRef(null);
  const [, force] = useState(0);
  const presence = useRef(null);
  const [peers, setPeers] = useState([]);

  const joined = !!session.client && !session.removed;

  /* ------------------------------------------------------------- painting */

  const paint = useCallback(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = wrap.getBoundingClientRect();
    if (cv.width !== Math.floor(r.width * dpr) || cv.height !== Math.floor(r.height * dpr)) {
      cv.width = Math.max(1, Math.floor(r.width * dpr));
      cv.height = Math.max(1, Math.floor(r.height * dpr));
    }
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);

    // Faint grid so an empty board doesn't look broken.
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1;
    const step = 32 * dpr;
    for (let x = 0; x < cv.width; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); }
    for (let y = 0; y < cv.height; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); }

    const all = session.strokes.toArray();
    const live = drawing.current ? [...all, drawing.current] : all;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of live) {
      if (!s || !s.p || s.p.length < 2) continue;
      ctx.strokeStyle = s.c;
      ctx.lineWidth = s.w * dpr;
      ctx.beginPath();
      // Points are stored normalised (0..1) so a stroke lands in the same
      // place on a collaborator's differently-sized viewport.
      ctx.moveTo(s.p[0] * cv.width, s.p[1] * cv.height);
      for (let i = 2; i < s.p.length; i += 2) ctx.lineTo(s.p[i] * cv.width, s.p[i + 1] * cv.height);
      if (s.p.length === 2) ctx.lineTo(s.p[0] * cv.width + 0.1, s.p[1] * cv.height + 0.1);
      ctx.stroke();
    }
  }, [session]);

  // `joined` is a dep because presence needs MLS state for its key: a session
  // that joins while this canvas is open (the Welcome arrived late) must
  // start presence then, not on the next reselect.
  useEffect(() => {
    paint();
    const onChange = () => { setCount(session.strokes.length); paint(); force((n) => n + 1); };
    session.onCanvasChange = onChange;
    const ro = new ResizeObserver(paint);
    if (wrapRef.current) ro.observe(wrapRef.current);

    const p = new Presence(session);
    p.onChange = () => setPeers([...p.peers.entries()].map(([id, v]) => ({ id, ...v })));
    p.connect();
    presence.current = p;

    return () => {
      session.onCanvasChange = null;
      ro.disconnect();
      p.close();
      presence.current = null;
    };
  }, [session, paint, joined]);

  /* ------------------------------------------------------------- pointers */

  const pos = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const down = (e) => {
    if (!joined) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);

    if (erasing) {
      const hit = hitTest(session.strokes.toArray(), x, y);
      if (hit >= 0) session.strokes.delete(hit, 1);
      return;
    }
    drawing.current = { c: color, w: width, p: [x, y] };
    paint();
  };

  const move = (e) => {
    const [cx, cy] = pos(e);
    presence.current?.move(cx, cy);
    if (!drawing.current) return;
    const [x, y] = pos(e);
    const p = drawing.current.p;
    // Skip samples closer than ~1px; freehand otherwise generates hundreds of
    // near-duplicate points per stroke, all of which we'd encrypt and ship.
    const dx = x - p[p.length - 2], dy = y - p[p.length - 1];
    if (dx * dx + dy * dy < 0.000004) return;
    p.push(x, y);
    paint();
  };

  const up = () => {
    if (!drawing.current) return;
    const s = drawing.current;
    drawing.current = null;
    // One Y.Array insert per finished stroke => one MLS message, not one per
    // pointer sample.
    if (s.p.length >= 2) session.strokes.push([s]);
    paint();
  };

  const undo = () => {
    const n = session.strokes.length;
    if (n) session.strokes.delete(n - 1, 1);
  };

  const clear = () => {
    if (!session.strokes.length) return;
    openModal?.({
      kind: "clear",
      onConfirm: () => session.strokes.delete(0, session.strokes.length),
    });
  };

  /* ----------------------------------------------------------------- view */

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.07] px-3 py-2 sm:px-5">
        <div className="flex items-center gap-1.5 rounded-xl border border-white/[0.07] bg-ink-900 px-2 py-1">
        <Palette className="mr-0.5 h-3.5 w-3.5 text-slate-500" />
        {COLORS.map((c) => (
          <button key={c} onClick={() => { setColor(c); setErasing(false); }} aria-label={`Colour ${c}`}
            className={`h-5 w-5 rounded-full transition hover:scale-110
              ${color === c && !erasing ? "scale-110 ring-2 ring-white ring-offset-2 ring-offset-ink-900" : "ring-1 ring-white/20"}`}
            style={{ background: c }} />
        ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-xl border border-white/[0.07] bg-ink-900 p-0.5">
        {WIDTHS.map((w) => (
          <button key={w} onClick={() => { setWidth(w); setErasing(false); }} aria-label={`Width ${w}`}
            className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors
              ${width === w && !erasing ? "bg-white/[0.12]" : "hover:bg-white/[0.06]"}`}>
            <span className="rounded-full bg-slate-300" style={{ width: w + 2, height: w + 2 }} />
          </button>
        ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-xl border border-white/[0.07] bg-ink-900 p-0.5">
        <button onClick={() => setErasing((v) => !v)} aria-label="Eraser" aria-pressed={erasing} title="Eraser"
          className={`rounded-lg p-1.5 transition-colors ${erasing ? "bg-rose-500/20 text-rose-300" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}>
          <Eraser className="h-4 w-4" />
        </button>
        <button onClick={undo} aria-label="Undo" disabled={!count} title="Undo"
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-30">
          <Undo2 className="h-4 w-4" />
        </button>
        <button onClick={clear} aria-label="Clear board" disabled={!count} title="Clear the board"
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-30">
          <Trash2 className="h-4 w-4" />
        </button>
        </div>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">
          {peers.length ? <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,.9)]" /> : null}
          {peers.length ? `${peers.length} live · ` : ""}{count} stroke{count === 1 ? "" : "s"} · e2ee
        </span>
      </div>

      <div ref={wrapRef} className="relative m-2 min-h-0 flex-1 overflow-hidden rounded-xl border border-white/[0.06] bg-black/50 [container-type:size] sm:m-3">
        <canvas
          ref={canvasRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={up}
          className={`absolute inset-0 h-full w-full touch-none ${erasing ? "cursor-cell" : "cursor-crosshair"} ${joined ? "" : "opacity-40"}`}
        />
        {peers.map((p) => (
          <div key={p.id}
            className="pointer-events-none absolute z-10 transition-transform duration-100 ease-linear"
            style={{ left: 0, top: 0, transform: `translate(${p.x * 100}cqw, ${p.y * 100}cqh)` }}>
            <svg width="18" height="18" viewBox="0 0 18 18" className="drop-shadow">
              <path d="M2 2 L2 14 L6 10.5 L8.5 16 L11 15 L8.5 9.5 L14 9 Z"
                fill="#22d3ee" stroke="#05060a" strokeWidth="1.2" />
            </svg>
            <span className="ml-3 rounded-md bg-cyan-400 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-950 shadow">
              {p.handle}
            </span>
          </div>
        ))}

        {!joined ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="max-w-xs text-center text-xs leading-relaxed text-slate-500">
              This device isn't a member yet. Once invited, a collaborator publishes the board
              at the new epoch — earlier strokes stay unreadable, by design.
            </p>
          </div>
        ) : count === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <PenLine className="h-6 w-6 text-slate-700" strokeWidth={1.5} />
            <p className="mt-3 text-sm font-medium text-slate-500">Draw something incriminating.</p>
            <p className="mt-1 text-xs text-slate-600">Every stroke is encrypted for this channel's members before it leaves.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Nearest-segment hit test in normalised space; -1 when nothing is close. */
function hitTest(strokes, x, y) {
  const TOL = 0.02;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const p = strokes[i]?.p;
    if (!p) continue;
    for (let j = 0; j < p.length - 2; j += 2) {
      if (distToSegment(x, y, p[j], p[j + 1], p[j + 2], p[j + 3]) < TOL) return i;
    }
    if (p.length === 2 && Math.hypot(x - p[0], y - p[1]) < TOL) return i;
  }
  return -1;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
