import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, ArrowUpRight, Boxes, Check, ChevronLeft,
  ChevronRight, CircleDot, Crosshair, Database, Eye, Fingerprint, Flame,
  Ghost, KeyRound, Layers, Lock, Menu, Play, Plus, Radio, Satellite, Server,
  Shield, ShieldCheck, Skull, Sparkles, Terminal, TrendingUp, Users, Wifi, X, Zap,
} from "lucide-react";

/* ------------------------------------------------------------------ *
 * DEADP0ET.ARMY — design + secure comms platform
 * Single-file React component. Tailwind for styling, Lucide for icons.
 * No animation libraries: CSS keyframes + Tailwind transitions only.
 * ------------------------------------------------------------------ */

/** The live encrypted console this page exists to funnel into. */
const CONSOLE_URL = "/app/";

/* ---------------------------------- data --------------------------------- */

const THREATS = [
  { id: "ghost",  icon: Ghost, name: "GHOST PROTOCOL", tag: "solo / small cell",
    blurb: "You have opinions and a podcast. Someone screenshotted both." },
  { id: "syndicate", icon: Boxes, name: "SYNDICATE", tag: "12–200 operators",
    blurb: "You have a design team, a roadmap, and at least one competitor with a budget for private investigators." },
  { id: "blackflag", icon: Flame, name: "BLACK FLAG", tag: "enterprise / state-adjacent",
    blurb: "Your legal department has a legal department. You already know why you're here." },
];

const TIERS = [
  { id: "civilian", name: "CIVILIAN", price: 0, seatCap: 5,
    line: "For people who still say \"I've got nothing to hide.\"" },
  { id: "operator", name: "OPERATOR", price: 49, seatCap: 250,
    line: "For people who said that once and learned something." },
  { id: "warlord", name: "WARLORD", price: 149, seatCap: 5000,
    line: "For people who are the reason this product exists." },
];

const ADDONS = [
  { id: "pqc",    icon: KeyRound,    name: "Post-Quantum Handshake", price: 29,
    note: "Because 2034 is going to be extremely rude to your 2024 encryption." },
  { id: "mesh",   icon: Satellite,   name: "Dead-Drop Mesh Relay", price: 19,
    note: "Routes around outages, censors, and that one ISP you hate." },
  { id: "studio", icon: Layers,      name: "Onyx Design Studio", price: 39,
    note: "Real-time canvas. Yes, it has a pen tool. No, it isn't cursed." },
  { id: "wipe",   icon: Flame,       name: "Panic Wipe Protocol", price: 25,
    note: "One keystroke. Everything gone. Deeply satisfying, wildly irreversible." },
  { id: "glyph",  icon: Sparkles,    name: "Custom Glyph Foundry", price: 15,
    note: "Your brand, but it looks like it could commit crimes." },
  { id: "concierge", icon: ShieldCheck, name: "24/7 Paranoia Concierge", price: 99,
    note: "A human answers in under 90 seconds. They will not judge you out loud." },
];

const FEATURES = [
  { icon: Shield, title: "Lattice Cipher Mesh", accent: "rose",
    body: "End-to-end, forward-secret, post-quantum-ready. We can't read your messages, which is convenient, because we didn't want to.",
    stat: "0 plaintext bytes at rest" },
  { icon: Layers, title: "Onyx Design Surface", accent: "fuchsia",
    body: "A collaborative canvas with vector tooling, live cursors and version history that doesn't lie to you about who broke the file.",
    stat: "60fps @ 8k artboards" },
  { icon: Satellite, title: "Dead-Drop Relays", accent: "cyan",
    body: "Traffic hops through 42 jurisdictions that famously do not return each other's phone calls.",
    stat: "42 relay jurisdictions" },
  { icon: Eye, title: "Zero-Knowledge Presence", accent: "rose",
    body: "Show who's online without revealing where, when, or on what. Your status is a vibe, not a subpoena.",
    stat: "Metadata retained: none" },
  { icon: Fingerprint, title: "Hardware Attestation", accent: "cyan",
    body: "Keys live in the secure element. Not in a .env file. Not in a Slack DM. We checked. Twice.",
    stat: "FIDO2 + TPM 2.0" },
  { icon: Flame, title: "Panic Wipe", accent: "fuchsia",
    body: "Cryptographic shredding across every enrolled device in under 400ms. Undo is not a feature. That's the feature.",
    stat: "<400ms full burn" },
];

const PREVIEWS = [
  { kicker: "01 — CANVAS", title: "Design in the dark.",
    sub: "Live multiplayer vector surface. Cursors, comments, and zero telemetry leaving the mesh.",
    grad: "from-rose-600/40 via-red-900/20 to-black" },
  { kicker: "02 — CHANNELS", title: "Say it once. Prove it never leaked.",
    sub: "Sealed-sender rooms with deniable authentication and per-message ratcheting.",
    grad: "from-fuchsia-600/35 via-purple-900/20 to-black" },
  { kicker: "03 — TELEMETRY", title: "Watch the perimeter breathe.",
    sub: "Relay health, handshake latency and anomaly scoring, streamed at 4Hz.",
    grad: "from-cyan-500/30 via-slate-900/30 to-black" },
  { kicker: "04 — BURN", title: "And then, nothing.",
    sub: "Panic wipe propagates to every enrolled device. Receipts optional. Regret standard.",
    grad: "from-red-700/45 via-black to-black" },
];

const TICKER = [
  "MESH NOMINAL", "42 RELAYS ONLINE", "0 SUBPOENAS HONORED", "PQC HANDSHAKE v3",
  "AUDIT: CLEAN", "LATENCY 11ms", "NO ADS. EVER. OBVIOUSLY.", "KEYS: YOURS",
  "TRUST NOBODY (INCLUDING US)", "UPTIME 99.997%",
];

const QUOTES = [
  { who: "Anonymous", role: "Series B founder, allegedly",
    text: "We moved off the chat app that reads your messages to sell you shoes. Radical, I know." },
  { who: "K. Voss", role: "Head of Design, undisclosed",
    text: "The canvas is faster than the one we were paying four times as much to be disappointed by." },
  { who: "[REDACTED]", role: "Compliance, [REDACTED]",
    text: "Our auditors asked for the message logs. There weren't any. Best meeting of my career." },
];

const LOG_LINES = [
  ["ok",   "handshake.pqc", "kyber1024 + x25519 negotiated"],
  ["ok",   "relay.mesh",    "path rebuilt via node RVN-07"],
  ["warn", "anomaly.score", "entropy dip on channel #foundry"],
  ["ok",   "canvas.sync",   "artboard delta 2.1kb applied"],
  ["ok",   "presence.zk",   "proof verified, identity withheld"],
  ["crit", "intrusion.hb",  "probe from 41.***.***.19 dropped"],
  ["ok",   "vault.seal",    "epoch rotated, prior keys shredded"],
  ["ok",   "audit.stream",  "merkle root anchored"],
];

const NODES = [
  { id: "RVN-07", region: "Reykjavík",  load: 34, ms: 9,  state: "ok" },
  { id: "OBS-12", region: "Zürich",     load: 61, ms: 14, state: "ok" },
  { id: "HEX-03", region: "Singapore",  load: 78, ms: 31, state: "warn" },
  { id: "NUL-19", region: "São Paulo",  load: 22, ms: 44, state: "ok" },
  { id: "VEX-01", region: "[REDACTED]", load: 93, ms: 7,  state: "crit" },
];

/* --------------------------------- helpers -------------------------------- */

/** Deterministic pseudo-random — stable across renders, no hydration drift. */
const seeded = (n) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");

/**
 * Chart series colours. Validated as a categorical pair against the #05060a
 * surface: lightness band PASS, chroma floor PASS, CVD separation ΔE 17.6
 * (deutan) / 37.4 (tritan) PASS, normal-vision ΔE 34.0 PASS, contrast PASS.
 * The brighter #22d3ee below is decorative UI only — never a data encoding.
 */
const SERIES = { ingress: "#fb3b53", egress: "#0ea5c4" };

const ACCENT = {
  rose:    { text: "text-rose-400",    ring: "ring-rose-500/40",    glow: "shadow-[0_0_50px_-12px_rgba(244,63,94,0.75)]",  from: "from-rose-500/25",    dot: "bg-rose-500",    hex: "#fb3b53" },
  fuchsia: { text: "text-fuchsia-400", ring: "ring-fuchsia-500/40", glow: "shadow-[0_0_50px_-12px_rgba(217,70,239,0.7)]",  from: "from-fuchsia-500/25", dot: "bg-fuchsia-500", hex: "#e879f9" },
  cyan:    { text: "text-cyan-300",    ring: "ring-cyan-400/40",    glow: "shadow-[0_0_50px_-12px_rgba(34,211,238,0.65)]", from: "from-cyan-400/25",    dot: "bg-cyan-400",    hex: "#22d3ee" },
};

/** Eases a number toward its target with rAF. Used for the animated total. */
function useAnimatedNumber(target, ms = 550) {
  const [val, setVal] = useState(target);
  const ref = useRef({ from: target, start: 0, raf: 0 });
  useEffect(() => {
    const s = ref.current;
    s.from = val;
    s.start = performance.now();
    cancelAnimationFrame(s.raf);
    const tick = (now) => {
      const p = clamp((now - s.start) / ms, 0, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(s.from + (target - s.from) * eased);
      if (p < 1) s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(s.raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ms]);
  return val;
}

/** True when the OS asks for reduced motion — we honour it everywhere. */
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** Reveal-on-scroll without a library. */
function useInView(threshold = 0.15) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && (setSeen(true), io.disconnect()),
      { threshold }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, seen];
}

/* ------------------------------ global styles ----------------------------- */

const KEYFRAMES = `
@keyframes dp-grid   { from { background-position: 0 0; }    to { background-position: 0 -800px; } }
@keyframes dp-scan   { 0% { transform: translateY(-120%); } 100% { transform: translateY(820%); } }
@keyframes dp-float  { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-14px) } }
@keyframes dp-drift  { 0%,100% { transform: translate(0,0) scale(1) } 33% { transform: translate(4%,-6%) scale(1.08) } 66% { transform: translate(-5%,4%) scale(.95) } }
@keyframes dp-ticker { from { transform: translateX(0) } to { transform: translateX(-50%) } }
@keyframes dp-glitch {
  0%,92%,100% { transform: translate(0,0); opacity: 0 }
  93% { transform: translate(-3px,1px); opacity: .85 }
  95% { transform: translate(2px,-2px); opacity: .6 }
  97% { transform: translate(-1px,2px); opacity: .9 }
}
@keyframes dp-blink  { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }
@keyframes dp-ring   { 0% { transform: scale(.7); opacity: .9 } 100% { transform: scale(2.2); opacity: 0 } }
@keyframes dp-sheen  { 0% { transform: translateX(-140%) skewX(-18deg) } 100% { transform: translateX(240%) skewX(-18deg) } }
@keyframes dp-rise   { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
@keyframes dp-dash   { to { stroke-dashoffset: 0 } }

.dp-range { -webkit-appearance: none; appearance: none; background: transparent; }
.dp-range::-webkit-slider-runnable-track { height: 6px; border-radius: 9999px;
  background: linear-gradient(90deg, #fb3b53 0%, #fb3b53 var(--p,50%), rgba(255,255,255,.09) var(--p,50%), rgba(255,255,255,.09) 100%); }
.dp-range::-moz-range-track { height: 6px; border-radius: 9999px; background: rgba(255,255,255,.09); }
.dp-range::-moz-range-progress { height: 6px; border-radius: 9999px; background: #fb3b53; }
.dp-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 20px; height: 20px;
  margin-top: -7px; border-radius: 9999px; background: #fff; border: 3px solid #fb3b53;
  box-shadow: 0 0 18px rgba(251,59,83,.9); cursor: grab; transition: transform .15s ease; }
.dp-range::-webkit-slider-thumb:active { transform: scale(1.18); cursor: grabbing; }
.dp-range::-moz-range-thumb { width: 16px; height: 16px; border-radius: 9999px; background: #fff;
  border: 3px solid #fb3b53; box-shadow: 0 0 18px rgba(251,59,83,.9); cursor: grab; }
.dp-range:focus-visible::-webkit-slider-thumb { outline: 2px solid #22d3ee; outline-offset: 2px; }

.dp-scroll::-webkit-scrollbar { height: 6px; width: 6px; }
.dp-scroll::-webkit-scrollbar-thumb { background: rgba(251,59,83,.45); border-radius: 9999px; }
.dp-scroll::-webkit-scrollbar-track { background: transparent; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important;
    transition-duration: .001ms !important; }
}
`;

/* ------------------------------ small pieces ------------------------------ */

function Glass({ className = "", children, ...rest }) {
  // Only claim `relative` when the caller hasn't positioned this itself — Tailwind
  // emits `relative` after `absolute`, so hardcoding it would silently win.
  const positioned = /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className);
  return (
    <div
      className={
        (positioned ? "" : "relative ") +
        "rounded-2xl border border-white/10 bg-white/[0.035] backdrop-blur-xl " +
        "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)] " + className
      }
      {...rest}
    >
      {children}
    </div>
  );
}

function Kicker({ children, accent = "rose" }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1
      text-[10px] font-mono uppercase tracking-[0.25em] ${ACCENT[accent].text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ACCENT[accent].dot} animate-pulse`} />
      {children}
    </span>
  );
}

function NeonButton({ children, onClick, href, variant = "primary", className = "", icon: Icon, ...rest }) {
  const base =
    "group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-xl px-6 py-3 " +
    "text-sm font-semibold tracking-wide transition-all duration-300 focus:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black " +
    "disabled:cursor-not-allowed disabled:opacity-40";
  const skins = {
    primary:
      "bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 text-white " +
      "shadow-[0_0_40px_-10px_rgba(244,63,94,0.9)] hover:shadow-[0_0_60px_-6px_rgba(244,63,94,1)] " +
      "hover:-translate-y-0.5 active:translate-y-0",
    ghost:
      "border border-white/15 bg-white/5 text-slate-200 backdrop-blur-md " +
      "hover:border-rose-500/50 hover:bg-white/10 hover:text-white hover:-translate-y-0.5",
  };
  // Real navigation gets a real anchor, so the console is middle-clickable,
  // copyable and crawlable rather than trapped behind an onClick.
  const Tag = href ? "a" : "button";
  const nav = href ? { href } : {};
  return (
    <Tag onClick={onClick} {...nav} className={`${base} ${skins[variant]} ${className}`} {...rest}>
      <span className="pointer-events-none absolute inset-0 -z-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100">
        <span className="absolute inset-y-0 w-1/3 bg-white/25 blur-md animate-[dp-sheen_1.1s_ease-out]" />
      </span>
      <span className="relative z-10 flex items-center gap-2">
        {Icon ? <Icon className="h-4 w-4 transition-transform duration-300 group-hover:rotate-12" /> : null}
        {children}
      </span>
    </Tag>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-300
        focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400
        ${checked
          ? "border-rose-400/60 bg-rose-600/80 shadow-[0_0_22px_-4px_rgba(244,63,94,0.95)]"
          : "border-white/15 bg-white/10"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-300 ease-out
          ${checked ? "left-[22px]" : "left-0.5"}`}
      />
    </button>
  );
}

function Slider({ value, min, max, step = 1, onChange, id }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ "--p": pct + "%" }}
      className="dp-range h-6 w-full cursor-pointer"
    />
  );
}

/* --------------------------- hero: 3D wireframe --------------------------- */

function WireframeCanvas({ className = "" }) {
  const ref = useRef(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(1, Math.floor(r.width * dpr));
      cv.height = Math.max(1, Math.floor(r.height * dpr));
    };
    resize();
    window.addEventListener("resize", resize);

    // Parametric torus — cheap to build, reads as "expensive 3D".
    const R = 1.65, r = 0.58, N = 30, M = 15;
    const verts = [];
    const edges = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M; j++) {
        const u = (i / N) * Math.PI * 2;
        const v = (j / M) * Math.PI * 2;
        verts.push([
          (R + r * Math.cos(v)) * Math.cos(u),
          (R + r * Math.cos(v)) * Math.sin(u),
          r * Math.sin(v),
        ]);
        const a = i * M + j;
        edges.push([a, ((i + 1) % N) * M + j], [a, i * M + ((j + 1) % M)]);
      }
    }
    const motes = Array.from({ length: 46 }, (_, i) => ({
      x: seeded(i + 1) * 2 - 1,
      y: seeded(i + 90) * 2 - 1,
      z: seeded(i + 400) * 2 - 1,
      s: 0.4 + seeded(i + 700) * 1.2,
    }));

    let t = 0.4;
    let raf = 0;
    let alive = true;

    const draw = () => {
      if (!alive) return;
      const w = cv.width, h = cv.height;
      const cx = w / 2, cy = h / 2, scale = Math.min(w, h) / 5.4;
      ctx.clearRect(0, 0, w, h);

      const ca = Math.cos(t), sa = Math.sin(t);
      const cb = Math.cos(t * 0.58 + 0.7), sb = Math.sin(t * 0.58 + 0.7);
      const project = ([x, y, z]) => {
        const x1 = x * ca - y * sa, y1 = x * sa + y * ca;
        const y2 = y1 * cb - z * sb, z2 = y1 * sb + z * cb;
        const k = 5.4 / (5.4 - z2);
        return [cx + x1 * scale * k, cy + y2 * scale * k, k];
      };

      const p = verts.map(project);

      ctx.lineWidth = Math.max(1, dpr * 0.9);
      ctx.lineCap = "round";
      for (let e = 0; e < edges.length; e++) {
        const a = p[edges[e][0]], b = p[edges[e][1]];
        const depth = (a[2] + b[2]) / 2;
        const f = clamp((depth - 0.78) * 2.1, 0, 1);
        if (f <= 0.02) continue;
        // Front of the shape burns red; the far side cools to cyan.
        const cr = Math.round(251 * f + 34 * (1 - f));
        const cg = Math.round(59 * f + 211 * (1 - f));
        const cb2 = Math.round(83 * f + 238 * (1 - f));
        ctx.strokeStyle = `rgba(${cr},${cg},${cb2},${0.08 + f * 0.62})`;
        ctx.shadowBlur = 12 * f * dpr;
        ctx.shadowColor = `rgba(${cr},${cg},${cb2},${0.5 * f})`;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }

      ctx.shadowBlur = 0;
      for (const m of motes) {
        const [mx, my, mk] = project([m.x * 3.1, m.y * 3.1, m.z * 2.2]);
        ctx.fillStyle = `rgba(255,255,255,${clamp((mk - 0.8) * 0.5, 0, 0.5)})`;
        ctx.beginPath();
        ctx.arc(mx, my, m.s * dpr * mk, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!reduced) {
        t += 0.0042;
        raf = requestAnimationFrame(draw);
      }
    };

    draw();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [reduced]);

  return <canvas ref={ref} aria-hidden="true" className={className} />;
}

/* ------------------------------- tilt cards ------------------------------- */

function TiltCard({ feature, index }) {
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, mx: 50, my: 50, on: false });
  const a = ACCENT[feature.accent];
  const Icon = feature.icon;

  const onMove = useCallback((e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    setTilt({ rx: (0.5 - py) * 12, ry: (px - 0.5) * 14, mx: px * 100, my: py * 100, on: true });
  }, []);

  return (
    <div
      onMouseMove={onMove}
      onMouseLeave={() => setTilt((t) => ({ ...t, rx: 0, ry: 0, on: false }))}
      style={{ perspective: "1100px", transitionDelay: `${index * 70}ms` }}
      className="group h-full"
    >
      <div
        style={{
          transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) translateZ(0) scale(${tilt.on ? 1.02 : 1})`,
          transformStyle: "preserve-3d",
        }}
        className={`relative h-full overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]
          p-6 backdrop-blur-xl transition-[transform,border-color,box-shadow] duration-300 ease-out
          hover:border-white/25 ${tilt.on ? a.glow : "shadow-none"}`}
      >
        {/* cursor-following gradient */}
        <div
          aria-hidden="true"
          style={{ background: `radial-gradient(420px circle at ${tilt.mx}% ${tilt.my}%, ${a.hex}22, transparent 65%)` }}
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
        />
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-br ${a.from}
            to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100`}
        />
        <div className="relative" style={{ transform: "translateZ(40px)" }}>
          <div className={`mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-white/10
            bg-black/50 ring-1 ${a.ring} transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6`}>
            <Icon className={`h-5 w-5 ${a.text}`} strokeWidth={1.75} />
          </div>
          <h3 className="text-lg font-semibold tracking-tight text-white">{feature.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">{feature.body}</p>
          <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
            <span className={`font-mono text-[11px] uppercase tracking-widest ${a.text}`}>{feature.stat}</span>
            <ArrowUpRight className="h-4 w-4 text-slate-600 transition-all duration-300 group-hover:translate-x-1 group-hover:-translate-y-1 group-hover:text-white" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- charts --------------------------------- */
/* Two series max per plot, one hue each (rose = ingress, cyan = egress), the   */
/* second dashed so identity never rests on colour alone. Single axis, always.  */

function TelemetryChart({ series, reduced }) {
  const [hover, setHover] = useState(null);
  const W = 720, H = 220, PAD_L = 8, PAD_R = 8, PAD_T = 14, PAD_B = 22;
  const n = series.length;
  const max = 100;

  const px = (i) => PAD_L + (i / (n - 1)) * (W - PAD_L - PAD_R);
  const py = (v) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);

  const path = (key) => series.map((d, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(d[key]).toFixed(1)}`).join(" ");
  const area = (key) =>
    `${path(key)} L${px(n - 1).toFixed(1)},${H - PAD_B} L${px(0).toFixed(1)},${H - PAD_B} Z`;

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = clamp((e.clientX - r.left) / r.width, 0, 1);
    const i = Math.round(ratio * (n - 1));
    setHover({ i, left: (px(i) / W) * 100 });
  };

  const last = series[n - 1];

  return (
    <div className="relative">
      {/* legend — always present for two series */}
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <span className="inline-flex items-center gap-2 text-xs text-slate-400">
          <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke={SERIES.ingress} strokeWidth="2" strokeLinecap="round" /></svg>
          Ingress
        </span>
        <span className="inline-flex items-center gap-2 text-xs text-slate-400">
          <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke={SERIES.egress} strokeWidth="2" strokeDasharray="5 3" strokeLinecap="round" /></svg>
          Egress
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-slate-600">Mbit/s · 4Hz</span>
      </div>

      <div className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
          aria-label="Relay throughput, ingress and egress, last 60 seconds">
          <defs>
            <linearGradient id="dp-fill-a" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES.ingress} stopOpacity="0.35" />
              <stop offset="100%" stopColor={SERIES.ingress} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* recessive grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={PAD_L} y1={py(v)} x2={W - PAD_R} y2={py(v)} stroke="rgba(255,255,255,0.055)" strokeWidth="1" />
              <text x={PAD_L} y={py(v) - 4} fill="rgba(148,163,184,0.5)" fontSize="9" fontFamily="ui-monospace, monospace">{v}</text>
            </g>
          ))}

          {/* Only the primary series gets a fill — two stacked translucent areas
              turn muddy where they overlap and neither reads cleanly. */}
          <path d={area("a")} fill="url(#dp-fill-a)" />
          <path d={path("b")} fill="none" stroke={SERIES.egress} strokeWidth="2" strokeDasharray="6 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d={path("a")} fill="none" stroke={SERIES.ingress} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

          {/* live end-caps double as direct labels */}
          <circle cx={px(n - 1)} cy={py(last.a)} r="4" fill={SERIES.ingress} />
          <circle cx={px(n - 1)} cy={py(last.a)} r="4" fill="none" stroke={SERIES.ingress} strokeWidth="1.5"
            className={reduced ? "" : "origin-center animate-[dp-ring_1.6s_ease-out_infinite]"}
            style={{ transformBox: "fill-box", transformOrigin: "center" }} />
          <circle cx={px(n - 1)} cy={py(last.b)} r="3.5" fill={SERIES.egress} />

          {hover ? (
            <g>
              <line x1={px(hover.i)} y1={PAD_T} x2={px(hover.i)} y2={H - PAD_B}
                stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="3 3" />
              <circle cx={px(hover.i)} cy={py(series[hover.i].a)} r="5" fill={SERIES.ingress} stroke="#05060a" strokeWidth="2" />
              <circle cx={px(hover.i)} cy={py(series[hover.i].b)} r="5" fill={SERIES.egress} stroke="#05060a" strokeWidth="2" />
            </g>
          ) : null}
        </svg>

        {hover ? (
          <div
            style={{ left: `${hover.left}%` }}
            className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-white/15
              bg-black/85 px-3 py-2 text-[11px] shadow-xl backdrop-blur-md"
          >
            <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-slate-500">
              T−{((n - 1 - hover.i) * 1.25).toFixed(1)}s
            </div>
            <div className="flex items-center gap-2 text-slate-300">
              <span className="h-2 w-2 rounded-full" style={{ background: SERIES.ingress }} />Ingress
              <span className="ml-auto font-mono text-white">{series[hover.i].a.toFixed(1)}</span>
            </div>
            <div className="flex items-center gap-2 text-slate-300">
              <span className="h-2 w-2 rounded-full" style={{ background: SERIES.egress }} />Egress
              <span className="ml-auto font-mono text-white">{series[hover.i].b.toFixed(1)}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Sparkline({ points, color }) {
  const W = 120, H = 34;
  const max = Math.max(...points, 1);
  const min = Math.min(...points);
  const span = Math.max(max - min, 1);
  const d = points
    .map((v, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * (H - 6) - 3).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-full" aria-hidden="true" preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
    </svg>
  );
}

function LoadBars({ bars }) {
  return (
    <div className="flex h-32 items-end gap-1.5" role="img" aria-label="Handshakes per second, last 14 intervals">
      {bars.map((v, i) => (
        <div key={i} className="group relative flex-1">
          <div
            style={{ height: `${v}%` }}
            className="w-full rounded-t bg-gradient-to-t from-rose-700/40 to-rose-500
              transition-[height] duration-700 ease-out group-hover:from-rose-500 group-hover:to-rose-300"
          />
          <span className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded border border-white/15
            bg-black/90 px-1.5 py-0.5 font-mono text-[10px] text-white opacity-0 transition-opacity duration-200
            group-hover:opacity-100">
            {Math.round(v * 3.4)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Gauge({ value, label, sublabel }) {
  const r = 52, C = 2 * Math.PI * r;
  const off = C * (1 - value / 100);
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-36 w-36">
        <svg viewBox="0 0 130 130" className="h-full w-full -rotate-90">
          <circle cx="65" cy="65" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="8" />
          <circle
            cx="65" cy="65" r={r} fill="none" stroke={SERIES.ingress} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={off}
            className="transition-[stroke-dashoffset] duration-1000 ease-out"
            style={{ filter: "drop-shadow(0 0 8px rgba(251,59,83,.8))" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-3xl font-bold text-white tabular-nums">{Math.round(value)}</span>
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">{sublabel}</span>
        </div>
      </div>
      <span className="mt-2 text-xs font-medium text-slate-400">{label}</span>
    </div>
  );
}

/* --------------------------------- sections -------------------------------- */

function Nav({ view, setView, onJump }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  const links = [
    ["Arsenal", "features"],
    ["Deploy", "deploy"],
    ["Receipts", "quotes"],
  ];

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-500
        ${scrolled ? "border-b border-white/10 bg-black/70 backdrop-blur-xl" : "border-b border-transparent bg-transparent"}`}
    >
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <button onClick={() => { setView("site"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          className="group flex items-center gap-2.5">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-600/10">
            <Skull className="h-5 w-5 text-rose-400 transition-transform duration-500 group-hover:rotate-12" strokeWidth={1.75} />
            <span className="absolute inset-0 rounded-lg bg-rose-500/25 blur-lg transition-opacity duration-500 group-hover:opacity-100 opacity-50" />
          </span>
          <span className="text-sm font-black tracking-[0.2em] text-white">
            DEADP0ET<span className="text-rose-500">.ARMY</span>
          </span>
        </button>

        <nav className="ml-6 hidden items-center gap-1 md:flex">
          {links.map(([label, id]) => (
            <button key={id} onClick={() => { setView("site"); onJump(id); }}
              className="rounded-lg px-3 py-2 text-sm text-slate-400 transition-colors duration-200 hover:bg-white/5 hover:text-white">
              {label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden rounded-xl border border-white/10 bg-white/5 p-1 backdrop-blur-md sm:flex">
            {[["site", "Site", Layers], ["dashboard", "Demo", Activity]].map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => { setView(id); window.scrollTo({ top: 0 }); }}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-300
                  ${view === id
                    ? "bg-rose-600 text-white shadow-[0_0_24px_-6px_rgba(244,63,94,1)]"
                    : "text-slate-400 hover:text-white"}`}
              >
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>
          <NeonButton className="hidden !px-4 !py-2 text-xs lg:inline-flex" icon={Lock} href={CONSOLE_URL}>
            Open console
          </NeonButton>
          <button onClick={() => setOpen((o) => !o)}
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 md:hidden"
            aria-label="Toggle menu">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <div className={`overflow-hidden border-t border-white/10 bg-black/90 backdrop-blur-xl transition-all duration-400 md:hidden
        ${open ? "max-h-72 opacity-100" : "max-h-0 opacity-0"}`}>
        <div className="space-y-1 px-4 py-3">
          {links.map(([label, id]) => (
            <button key={id} onClick={() => { setOpen(false); setView("site"); onJump(id); }}
              className="block w-full rounded-lg px-3 py-2.5 text-left text-sm text-slate-300 hover:bg-white/5">
              {label}
            </button>
          ))}
          <a href={CONSOLE_URL}
            className="block w-full rounded-lg bg-rose-600/90 px-3 py-2.5 text-left text-sm font-semibold text-white">
            Open console
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero({ onJump }) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!playing || reduced) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % PREVIEWS.length), 4200);
    return () => clearInterval(id);
  }, [playing, reduced]);

  const p = PREVIEWS[frame];

  return (
    <section className="relative min-h-[100svh] overflow-hidden pt-28 pb-16">
      {/* perspective floor */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[55vh] [perspective:520px]">
        <div
          className="absolute inset-0 origin-bottom animate-[dp-grid_9s_linear_infinite] opacity-45"
          style={{
            transform: "rotateX(72deg) scale(2.4)",
            backgroundImage:
              "linear-gradient(rgba(251,59,83,0.42) 1px, transparent 1px), linear-gradient(90deg, rgba(251,59,83,0.22) 1px, transparent 1px)",
            backgroundSize: "80px 80px",
            maskImage: "linear-gradient(to top, black, transparent 78%)",
            WebkitMaskImage: "linear-gradient(to top, black, transparent 78%)",
          }}
        />
      </div>

      {/* ambient blobs */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-32 top-10 h-[34rem] w-[34rem] rounded-full bg-rose-600/20 blur-[130px] animate-[dp-drift_19s_ease-in-out_infinite]" />
        <div className="absolute -right-40 top-1/3 h-[30rem] w-[30rem] rounded-full bg-fuchsia-600/15 blur-[130px] animate-[dp-drift_23s_ease-in-out_infinite_reverse]" />
        <div className="absolute left-1/3 bottom-0 h-80 w-80 rounded-full bg-cyan-500/10 blur-[110px] animate-[dp-drift_27s_ease-in-out_infinite]" />
      </div>

      <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:gap-8 lg:px-8">
        {/* copy */}
        <div className="animate-[dp-rise_0.8s_ease-out_both]">
          <Kicker>Now with 40% more paranoia</Kicker>

          <h1 className="relative mt-6 text-5xl font-black leading-[0.95] tracking-tighter text-white sm:text-6xl lg:text-7xl">
            <span className="relative inline-block">
              Design like
              <span aria-hidden="true"
                className="absolute inset-0 text-cyan-400 mix-blend-screen animate-[dp-glitch_5s_infinite_steps(1)]">
                Design like
              </span>
            </span>
            <br />
            <span className="relative inline-block bg-gradient-to-r from-rose-500 via-red-500 to-fuchsia-500 bg-clip-text text-transparent">
              nobody's watching.
              <span aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-r from-cyan-400 to-cyan-200 bg-clip-text text-transparent animate-[dp-glitch_7s_infinite_steps(1)]">
                nobody's watching.
              </span>
            </span>
            <br />
            <span className="text-slate-500">Because nobody is.</span>
          </h1>

          <p className="mt-6 max-w-lg text-base leading-relaxed text-slate-400 sm:text-lg">
            A collaborative design surface welded to end-to-end encrypted comms. Your files, your
            keys, your problem. We built the vault; we genuinely cannot open it.{" "}
            <span className="text-slate-500">We've tried. It was a whole meeting.</span>
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <NeonButton icon={Zap} href={CONSOLE_URL}>Open the console</NeonButton>
            <NeonButton variant="ghost" icon={Terminal} onClick={() => onJump("deploy")}>
              Price it up
            </NeonButton>
          </div>

          <dl className="mt-10 grid max-w-md grid-cols-3 gap-4 border-t border-white/10 pt-6">
            {[["11ms", "median relay"], ["42", "jurisdictions"], ["0", "ads, ever"]].map(([v, k], i) => (
              <div key={k} style={{ animationDelay: `${300 + i * 120}ms` }} className="animate-[dp-rise_0.7s_ease-out_both]">
                <dt className="font-mono text-2xl font-bold text-white">{v}</dt>
                <dd className="mt-0.5 text-[11px] uppercase tracking-widest text-slate-500">{k}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* 3D canvas + auto-scrolling preview */}
        <div className="relative animate-[dp-rise_0.9s_ease-out_both] [animation-delay:200ms]">
          <Glass className="overflow-hidden p-2 shadow-[0_0_90px_-30px_rgba(244,63,94,0.85)]">
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-black">
              <div className={`absolute inset-0 bg-gradient-to-br ${p.grad} transition-all duration-1000 ease-out`} />
              <WireframeCanvas className="absolute inset-0 h-full w-full" />

              {/* scanline + noise */}
              <div aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-white/10 to-transparent animate-[dp-scan_5.5s_linear_infinite]" />
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.18]"
                style={{ backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,.25) 0 1px, transparent 1px 3px)" }} />

              {/* HUD corners */}
              {["left-3 top-3 border-l-2 border-t-2", "right-3 top-3 border-r-2 border-t-2",
                "left-3 bottom-3 border-b-2 border-l-2", "right-3 bottom-3 border-b-2 border-r-2"].map((c) => (
                <span key={c} aria-hidden="true" className={`absolute h-5 w-5 border-rose-500/70 ${c}`} />
              ))}

              {/* rec dot */}
              <div className="absolute left-5 top-5 flex items-center gap-2 font-mono text-[10px] tracking-[0.25em] text-rose-300">
                <span className="h-2 w-2 rounded-full bg-rose-500 animate-[dp-blink_1.4s_step-end_infinite]" />
                REC · LIVE
              </div>

              {/* typography overlay */}
              <div key={frame} className="absolute inset-x-0 bottom-0 p-5 sm:p-7 animate-[dp-rise_0.6s_ease-out_both]">
                <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-rose-300">{p.kicker}</span>
                <h2 className="mt-2 text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl">{p.title}</h2>
                <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-slate-300 sm:text-sm">{p.sub}</p>
              </div>
            </div>

            {/* transport */}
            <div className="flex items-center gap-3 px-3 py-3">
              <button onClick={() => setPlaying((v) => !v)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 transition-colors hover:border-rose-500/50 hover:text-white"
                aria-label={playing ? "Pause preview" : "Play preview"}>
                {playing ? <span className="flex gap-0.5"><span className="h-3 w-1 bg-current" /><span className="h-3 w-1 bg-current" /></span> : <Play className="h-3.5 w-3.5" />}
              </button>
              <div className="flex flex-1 gap-1.5">
                {PREVIEWS.map((_, i) => (
                  <button key={i} onClick={() => setFrame(i)} aria-label={`Preview ${i + 1}`}
                    className="group relative h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                    <span className={`absolute inset-y-0 left-0 rounded-full bg-rose-500 transition-all
                      ${i < frame ? "w-full duration-300" : i === frame ? "w-full duration-[4200ms] ease-linear" : "w-0 duration-300"}`}
                      style={{ transitionProperty: "width" }} />
                  </button>
                ))}
              </div>
              <span className="shrink-0 font-mono text-[10px] text-slate-500">
                {String(frame + 1).padStart(2, "0")}/{String(PREVIEWS.length).padStart(2, "0")}
              </span>
            </div>
          </Glass>

          {/* floating chips */}
          <Glass className="absolute -left-5 top-32 hidden items-center gap-2 px-3 py-2 animate-[dp-float_6s_ease-in-out_infinite] lg:flex">
            <ShieldCheck className="h-4 w-4 text-cyan-300" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-300">E2EE · verified</span>
          </Glass>
          <Glass className="absolute -right-4 bottom-36 hidden items-center gap-2 px-3 py-2 animate-[dp-float_7.5s_ease-in-out_infinite_1s] lg:flex">
            <Radio className="h-4 w-4 text-rose-400" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-300">42 relays</span>
          </Glass>
        </div>
      </div>
    </section>
  );
}

function Ticker() {
  const items = [...TICKER, ...TICKER];
  return (
    <div className="relative overflow-hidden border-y border-white/10 bg-black/60 py-3 backdrop-blur-sm">
      <div className="flex w-max animate-[dp-ticker_38s_linear_infinite] gap-8 whitespace-nowrap will-change-transform">
        {items.map((t, i) => (
          <span key={i} className="flex items-center gap-8 font-mono text-[11px] uppercase tracking-[0.3em] text-slate-500">
            {t}
            <CircleDot className="h-3 w-3 text-rose-600/70" />
          </span>
        ))}
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-black to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-black to-transparent" />
    </div>
  );
}

function Features() {
  const [ref, seen] = useInView();
  return (
    <section id="features" ref={ref} className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="max-w-2xl">
        <Kicker accent="fuchsia">The arsenal</Kicker>
        <h2 className="mt-5 text-4xl font-black tracking-tighter text-white sm:text-5xl">
          Everything they promised you,
          <span className="block text-slate-500">except this time it's true.</span>
        </h2>
        <p className="mt-4 text-slate-400">
          Six subsystems. No growth team. Nobody here has ever said the word "engagement" out loud.
        </p>
      </div>

      <div className={`mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 transition-all duration-700
        ${seen ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}>
        {FEATURES.map((f, i) => <TiltCard key={f.title} feature={f} index={i} />)}
      </div>
    </section>
  );
}

/* -------------------- stepper + live pricing calculator -------------------- */

const STEP_LABELS = ["Threat model", "Configure", "Add-ons", "Confirm"];

function Deploy({ config, setConfig }) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  const tier = TIERS.find((t) => t.id === config.tier) || TIERS[1];

  const breakdown = useMemo(() => {
    const seats = tier.price === 0 ? Math.min(config.seats, tier.seatCap) : config.seats;
    const seatCost = tier.price * seats;
    const addonCost = ADDONS.filter((a) => config.addons.includes(a.id)).reduce((s, a) => s + a.price, 0);
    const retentionCost = Math.round((config.retention / 30) * 12);
    const sub = seatCost + addonCost + retentionCost;
    const discount = config.annual ? Math.round(sub * 0.2) : 0;
    // Round once, here — so the /yr figure is always exactly 12× the /mo figure.
    return { seats, seatCost, addonCost, retentionCost, sub, discount, total: sub - discount };
  }, [tier, config]);

  const animatedTotal = useAnimatedNumber(breakdown.total);
  const animatedYear = useAnimatedNumber(breakdown.total * 12);

  const go = (d) => { setDir(d); setStep((s) => clamp(s + d, 0, STEP_LABELS.length - 1)); };
  const toggleAddon = (id) =>
    setConfig((c) => ({ ...c, addons: c.addons.includes(id) ? c.addons.filter((x) => x !== id) : [...c.addons, id] }));

  return (
    <section id="deploy" className="relative border-y border-white/10 bg-gradient-to-b from-black via-slate-950/60 to-black py-24">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-0 h-96 w-[46rem] -translate-x-1/2 rounded-full bg-rose-700/12 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <Kicker>Configure &amp; deploy</Kicker>
          <h2 className="mt-5 text-4xl font-black tracking-tighter text-white sm:text-5xl">
            Build your rig.
            <span className="block text-slate-500">The price moves. Watch it move.</span>
          </h2>
        </div>

        {/* progress rail */}
        <div className="mt-12 flex items-center">
          {STEP_LABELS.map((label, i) => (
            <React.Fragment key={label}>
              <button
                onClick={() => { setDir(i > step ? 1 : -1); setStep(i); }}
                className="group flex shrink-0 flex-col items-center gap-2 sm:flex-row sm:gap-3"
              >
                <span className={`relative flex h-9 w-9 items-center justify-center rounded-full border text-xs font-bold
                  transition-all duration-500
                  ${i < step ? "border-rose-500 bg-rose-600 text-white"
                    : i === step ? "border-rose-500 bg-black text-rose-400 shadow-[0_0_28px_-4px_rgba(244,63,94,1)]"
                    : "border-white/15 bg-white/5 text-slate-500"}`}>
                  {i < step ? <Check className="h-4 w-4" /> : String(i + 1).padStart(2, "0")}
                  {i === step ? <span className="absolute inset-0 rounded-full border border-rose-500 animate-[dp-ring_1.8s_ease-out_infinite]" /> : null}
                </span>
                <span className={`text-[10px] uppercase tracking-widest transition-colors duration-300 sm:text-xs
                  ${i === step ? "text-white" : "text-slate-500 group-hover:text-slate-300"}`}>
                  {label}
                </span>
              </button>
              {i < STEP_LABELS.length - 1 ? (
                <span className="mx-2 h-px flex-1 overflow-hidden bg-white/10 sm:mx-4">
                  <span className={`block h-full bg-gradient-to-r from-rose-500 to-fuchsia-500 transition-all duration-700 ease-out
                    ${i < step ? "w-full" : "w-0"}`} />
                </span>
              ) : null}
            </React.Fragment>
          ))}
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-5">
          {/* ------------------------------ stepper panes ------------------------------ */}
          <Glass className="p-6 sm:p-8 lg:col-span-3">
            <div key={step} className={dir > 0 ? "animate-[dp-rise_0.45s_ease-out_both]" : "animate-[dp-rise_0.45s_ease-out_both]"}>
              {step === 0 ? (
                <div>
                  <h3 className="text-xl font-bold text-white">Who's after you?</h3>
                  <p className="mt-1.5 text-sm text-slate-400">Be honest. The answer changes the defaults, not the price.</p>
                  <div className="mt-6 space-y-3">
                    {THREATS.map((t) => {
                      const Icon = t.icon;
                      const on = config.threat === t.id;
                      return (
                        <button key={t.id} onClick={() => setConfig((c) => ({ ...c, threat: t.id }))}
                          className={`group flex w-full items-start gap-4 rounded-xl border p-4 text-left transition-all duration-300
                            ${on ? "border-rose-500/60 bg-rose-600/10 shadow-[0_0_40px_-16px_rgba(244,63,94,1)]"
                                 : "border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.05]"}`}>
                          <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-all duration-300
                            ${on ? "border-rose-500/50 bg-rose-600/20" : "border-white/10 bg-black/40 group-hover:scale-110"}`}>
                            <Icon className={`h-5 w-5 ${on ? "text-rose-400" : "text-slate-400"}`} strokeWidth={1.75} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-sm font-bold tracking-wider text-white">{t.name}</span>
                              <span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-slate-500">{t.tag}</span>
                            </span>
                            <span className="mt-1 block text-sm text-slate-400">{t.blurb}</span>
                          </span>
                          <span className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all duration-300
                            ${on ? "border-rose-500 bg-rose-500" : "border-white/20"}`}>
                            {on ? <Check className="h-3 w-3 text-white" /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {step === 1 ? (
                <div>
                  <h3 className="text-xl font-bold text-white">Size the operation.</h3>
                  <p className="mt-1.5 text-sm text-slate-400">Slide things. The number on the right reacts. It's the whole gimmick.</p>

                  <div className="mt-6 grid gap-3 sm:grid-cols-3">
                    {TIERS.map((t) => {
                      const on = config.tier === t.id;
                      return (
                        <button key={t.id} onClick={() => setConfig((c) => ({ ...c, tier: t.id, seats: clamp(c.seats, 1, t.seatCap) }))}
                          className={`relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-300
                            ${on ? "border-rose-500/60 bg-gradient-to-b from-rose-600/20 to-transparent shadow-[0_0_40px_-16px_rgba(244,63,94,1)]"
                                 : "border-white/10 bg-white/[0.02] hover:border-white/25 hover:-translate-y-0.5"}`}>
                          <span className="font-mono text-xs font-bold tracking-[0.2em] text-white">{t.name}</span>
                          <span className="mt-2 block font-mono text-2xl font-black text-white">
                            {t.price === 0 ? "FREE" : `$${t.price}`}
                            {t.price ? <span className="text-xs font-normal text-slate-500">/seat</span> : null}
                          </span>
                          <span className="mt-2 block text-[11px] leading-snug text-slate-500">{t.line}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-8 space-y-7">
                    <div>
                      <div className="flex items-end justify-between">
                        <label htmlFor="seats" className="text-sm font-medium text-slate-300">Operators</label>
                        <span className="font-mono text-lg font-bold text-rose-400 tabular-nums">
                          {breakdown.seats}
                          {tier.price === 0 && config.seats > tier.seatCap ? (
                            <span className="ml-2 text-[10px] uppercase tracking-widest text-amber-400">capped at {tier.seatCap}</span>
                          ) : null}
                        </span>
                      </div>
                      <div className="mt-3">
                        <Slider id="seats" value={config.seats} min={1} max={250}
                          onChange={(v) => setConfig((c) => ({ ...c, seats: v }))} />
                      </div>
                      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-600"><span>1</span><span>250</span></div>
                    </div>

                    <div>
                      <div className="flex items-end justify-between">
                        <label htmlFor="ret" className="text-sm font-medium text-slate-300">Message retention</label>
                        <span className="font-mono text-lg font-bold text-rose-400 tabular-nums">{config.retention}d</span>
                      </div>
                      <div className="mt-3">
                        <Slider id="ret" value={config.retention} min={1} max={365} step={1}
                          onChange={(v) => setConfig((c) => ({ ...c, retention: v }))} />
                      </div>
                      <p className="mt-2 text-[11px] text-slate-500">
                        {config.retention <= 7
                          ? "Aggressively forgetful. Your lawyers will send flowers."
                          : config.retention >= 200
                          ? "That's a lot of history to keep. Bold. Legally interesting."
                          : "A reasonable amount of memory for an unreasonable world."}
                      </p>
                    </div>

                    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] p-4">
                      <div>
                        <p className="text-sm font-medium text-slate-200">Annual billing</p>
                        <p className="text-[11px] text-slate-500">Save 20%. Commit to us the way we've committed to you.</p>
                      </div>
                      <Switch checked={config.annual} onChange={(v) => setConfig((c) => ({ ...c, annual: v }))} label="Annual billing" />
                    </div>
                  </div>
                </div>
              ) : null}

              {step === 2 ? (
                <div>
                  <h3 className="text-xl font-bold text-white">Optional paranoia.</h3>
                  <p className="mt-1.5 text-sm text-slate-400">Flat monthly rates, org-wide. No per-seat gotchas — we're insufferable, not evil.</p>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    {ADDONS.map((a) => {
                      const Icon = a.icon;
                      const on = config.addons.includes(a.id);
                      return (
                        <button key={a.id} onClick={() => toggleAddon(a.id)}
                          className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-300
                            ${on ? "border-rose-500/60 bg-rose-600/10 shadow-[0_0_36px_-16px_rgba(244,63,94,1)]"
                                 : "border-white/10 bg-white/[0.02] hover:border-white/25 hover:-translate-y-0.5"}`}>
                          <div className="flex items-start gap-3">
                            <Icon className={`mt-0.5 h-5 w-5 shrink-0 transition-colors duration-300 ${on ? "text-rose-400" : "text-slate-500"}`} strokeWidth={1.75} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="text-sm font-semibold text-white">{a.name}</span>
                                <span className={`font-mono text-xs ${on ? "text-rose-400" : "text-slate-500"}`}>+${a.price}</span>
                              </div>
                              <p className="mt-1 text-[11px] leading-snug text-slate-500">{a.note}</p>
                            </div>
                            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-all duration-300
                              ${on ? "border-rose-500 bg-rose-500 rotate-0" : "border-white/20 rotate-90"}`}>
                              {on ? <Check className="h-3 w-3 text-white" /> : <Plus className="h-3 w-3 text-slate-400" />}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {step === 3 ? (
                <div>
                  <h3 className="text-xl font-bold text-white">Confirm the loadout.</h3>
                  <p className="mt-1.5 text-sm text-slate-400">Last chance to pretend you don't need this.</p>

                  <dl className="mt-6 divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
                    {[
                      ["Threat model", (THREATS.find((t) => t.id === config.threat) || THREATS[0]).name],
                      ["Tier", tier.name],
                      ["Operators", `${breakdown.seats}`],
                      ["Retention", `${config.retention} days`],
                      ["Add-ons", config.addons.length ? `${config.addons.length} selected` : "None — living dangerously"],
                      ["Billing", config.annual ? "Annual (−20%)" : "Monthly"],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between bg-white/[0.02] px-4 py-3">
                        <dt className="text-xs uppercase tracking-widest text-slate-500">{k}</dt>
                        <dd className="font-mono text-sm text-white">{v}</dd>
                      </div>
                    ))}
                  </dl>

                  {/* This used to fake a "keys generated" state. There is a real
                      console now, so it hands off to the thing that actually
                      generates keys instead of pretending to. */}
                  <a
                    href={CONSOLE_URL}
                    className="group relative mt-6 flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl px-6 py-4
                      text-sm font-bold tracking-wide transition-all duration-500
                      bg-gradient-to-r from-rose-600 to-red-700 text-white
                      shadow-[0_0_50px_-12px_rgba(244,63,94,1)] hover:-translate-y-0.5"
                  >
                    <Fingerprint className="h-5 w-5 transition-transform duration-300 group-hover:scale-110" />
                    Open the console — {money(breakdown.total)}/mo
                    <span aria-hidden="true" className="absolute inset-y-0 w-1/3 bg-white/20 blur-lg opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-hover:animate-[dp-sheen_1.2s_ease-out]" />
                  </a>
                  <p className="mt-3 text-center text-[11px] text-slate-600">
                    Passkey only, no card, no trial timer. Keys are generated in your browser
                    and never sent to us.
                  </p>
                </div>
              ) : null}
            </div>

            {/* nav */}
            <div className="mt-8 flex items-center justify-between border-t border-white/10 pt-6">
              <button onClick={() => go(-1)} disabled={step === 0}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-slate-400 transition-colors hover:text-white disabled:opacity-30 disabled:hover:text-slate-400">
                <ChevronLeft className="h-4 w-4" /> Back
              </button>
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-600">
                Step {step + 1} of {STEP_LABELS.length}
              </span>
              <NeonButton className="!px-4 !py-2 text-xs" onClick={() => go(1)} disabled={step === STEP_LABELS.length - 1}>
                Next <ChevronRight className="h-4 w-4" />
              </NeonButton>
            </div>
          </Glass>

          {/* ------------------------------ live price card ---------------------------- */}
          <div className="lg:col-span-2">
            <Glass className="sticky top-24 overflow-hidden p-6 sm:p-7">
              <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-rose-600/25 blur-3xl" />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Live total</span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> recalculating
                  </span>
                </div>

                <div className="mt-4 flex items-end gap-2">
                  <span className="bg-gradient-to-br from-white via-rose-100 to-rose-400 bg-clip-text font-mono text-5xl font-black tabular-nums text-transparent sm:text-6xl">
                    {money(animatedTotal)}
                  </span>
                  <span className="mb-2 text-sm text-slate-500">/mo</span>
                </div>
                <p className="mt-1 font-mono text-[11px] text-slate-500">
                  {money(animatedYear)} / year · billed {config.annual ? "annually" : "monthly"}
                </p>

                <dl className="mt-6 space-y-2.5 border-t border-white/10 pt-5 text-sm">
                  {[
                    [`${tier.name} × ${breakdown.seats} seats`, breakdown.seatCost],
                    [`Add-ons (${config.addons.length})`, breakdown.addonCost],
                    [`Retention · ${config.retention}d`, breakdown.retentionCost],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between">
                      <dt className="text-slate-400">{k}</dt>
                      <dd className="font-mono tabular-nums text-slate-200">{money(v)}</dd>
                    </div>
                  ))}
                  <div className={`flex items-center justify-between transition-all duration-500
                    ${config.annual ? "max-h-10 opacity-100" : "max-h-0 overflow-hidden opacity-0"}`}>
                    <dt className="text-emerald-400">Annual discount</dt>
                    <dd className="font-mono tabular-nums text-emerald-400">−{money(breakdown.discount)}</dd>
                  </div>
                </dl>

                <div className="mt-5 space-y-2 border-t border-white/10 pt-5">
                  {config.addons.length === 0 ? (
                    <p className="text-[11px] text-slate-600">No add-ons. Minimalist. Reckless. Respect.</p>
                  ) : (
                    ADDONS.filter((a) => config.addons.includes(a.id)).map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-[11px] text-slate-400 animate-[dp-rise_0.35s_ease-out_both]">
                        <Check className="h-3 w-3 shrink-0 text-rose-400" />
                        <span className="truncate">{a.name}</span>
                        <span className="ml-auto font-mono text-slate-600">${a.price}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-6 rounded-xl border border-white/10 bg-black/40 p-4">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                    <span className="font-mono text-[10px] uppercase tracking-widest text-amber-400">Disclosure</span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                    Prices are simulated, as is this entire operation. Any resemblance to a company
                    that would actually survive an audit is purely aspirational.
                  </p>
                </div>
              </div>
            </Glass>
          </div>
        </div>
      </div>
    </section>
  );
}

function Quotes() {
  const [ref, seen] = useInView();
  return (
    <section id="quotes" ref={ref} className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <div className="max-w-2xl">
        <Kicker accent="cyan">Receipts</Kicker>
        <h2 className="mt-5 text-4xl font-black tracking-tighter text-white sm:text-5xl">
          People say things.
          <span className="block text-slate-500">We can't verify who. That's the point.</span>
        </h2>
      </div>
      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {QUOTES.map((q, i) => (
          <Glass key={q.who}
            style={{ transitionDelay: `${i * 110}ms` }}
            className={`group relative overflow-hidden p-6 transition-all duration-700 hover:-translate-y-1 hover:border-rose-500/40
              ${seen ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}>
            <div aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-gradient-to-br from-rose-500/0 via-fuchsia-500/0 to-cyan-400/0
                opacity-0 transition-all duration-500 group-hover:from-rose-500/15 group-hover:to-cyan-400/10 group-hover:opacity-100" />
            <div className="relative">
              <Crosshair className="h-5 w-5 text-rose-500/70" />
              <p className="mt-4 text-sm leading-relaxed text-slate-300">"{q.text}"</p>
              <div className="mt-5 flex items-center gap-3 border-t border-white/10 pt-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/50 font-mono text-[10px] text-rose-400">
                  {q.who.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-white">{q.who}</p>
                  <p className="truncate text-[11px] text-slate-500">{q.role}</p>
                </div>
              </div>
            </div>
          </Glass>
        ))}
      </div>
    </section>
  );
}

function Footer({ setView }) {
  return (
    <footer className="relative overflow-hidden border-t border-white/10 bg-black">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-rose-700/15 blur-[100px]" />
      <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-4">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2.5">
              <Skull className="h-6 w-6 text-rose-500" strokeWidth={1.75} />
              <span className="text-sm font-black tracking-[0.2em] text-white">DEADP0ET<span className="text-rose-500">.ARMY</span></span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-500">
              Design tooling and encrypted comms for people who read the terms of service and
              didn't like what they found. Built by four people and one extremely tired server.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {["SOC2 (pending, honestly)", "Audited 2026", "Open protocol"].map((b) => (
                <span key={b} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  {b}
                </span>
              ))}
            </div>
          </div>
          {[
            ["Platform", ["Canvas", "Channels", "Relays", "Vault"]],
            ["Company", ["Manifesto", "Warrant canary", "Careers (none)", "Contact"]],
          ].map(([title, items]) => (
            <div key={title}>
              <h4 className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-400">{title}</h4>
              <ul className="mt-4 space-y-2.5">
                {items.map((it) => (
                  <li key={it}>
                    <button className="group inline-flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-white">
                      {it}
                      <ArrowRight className="h-3 w-3 -translate-x-1 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 sm:flex-row">
          <p className="font-mono text-[11px] text-slate-600">
            © 2026 DEADP0ET.ARMY — we still don't know who you are, and we like it that way.
          </p>
          <div className="flex items-center gap-5">
            <button onClick={() => { setView("dashboard"); window.scrollTo({ top: 0 }); }}
              className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-slate-500 transition-colors hover:text-slate-300">
              <Activity className="h-3.5 w-3.5" /> Telemetry demo
            </button>
            <a href={CONSOLE_URL}
              className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-rose-500 transition-colors hover:text-rose-300">
              <Lock className="h-3.5 w-3.5" /> Open console
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

/* -------------------------------- dashboard -------------------------------- */

function Dashboard({ config }) {
  const reduced = useReducedMotion();
  const [series, setSeries] = useState(() =>
    Array.from({ length: 48 }, (_, i) => ({
      a: 40 + seeded(i + 3) * 30 + Math.sin(i / 5) * 12,
      b: 26 + seeded(i + 71) * 22 + Math.cos(i / 6) * 9,
    }))
  );
  const [bars, setBars] = useState(() => Array.from({ length: 14 }, (_, i) => 25 + seeded(i + 11) * 70));
  const [gauge, setGauge] = useState(72);
  const [logs, setLogs] = useState(() => LOG_LINES.slice(0, 5).map((l, i) => ({ l, k: i })));
  const [uptimeSec, setUptimeSec] = useState(1487233);
  const tick = useRef(0);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => {
      tick.current += 1;
      const t = tick.current;
      setSeries((s) => {
        const prev = s[s.length - 1];
        const next = {
          a: clamp(prev.a + (seeded(t * 1.7) - 0.48) * 16, 12, 96),
          b: clamp(prev.b + (seeded(t * 3.1 + 5) - 0.5) * 12, 6, 74),
        };
        return [...s.slice(1), next];
      });
      setBars((b) => [...b.slice(1), clamp(20 + seeded(t * 5.3) * 78, 12, 98)]);
      setGauge((g) => clamp(g + (seeded(t * 7.7) - 0.5) * 11, 38, 97));
      setUptimeSec((u) => u + 1);
      if (t % 3 === 0) {
        setLogs((L) => [{ l: LOG_LINES[t % LOG_LINES.length], k: t }, ...L].slice(0, 7));
      }
    }, 1250);
    return () => clearInterval(id);
  }, [reduced]);

  const last = series[series.length - 1];
  const prev = series[series.length - 2] || last;

  const tiles = [
    { label: "Ingress", value: last.a.toFixed(1), unit: "Mb/s", delta: last.a - prev.a,
      color: SERIES.ingress, spark: series.slice(-24).map((d) => d.a), icon: TrendingUp },
    { label: "Active operators", value: String(Math.max(1, Math.round(config.seats * 0.62))), unit: "online",
      delta: 2, color: SERIES.egress, spark: series.slice(-24).map((d) => d.b), icon: Users },
    { label: "Sealed sessions", value: String(1240 + Math.round(last.a * 7)), unit: "live",
      delta: last.a - prev.a, color: "#e879f9", spark: bars.slice(-14), icon: Lock },
    { label: "Anomaly score", value: (2.4 + (100 - gauge) / 40).toFixed(2), unit: "σ",
      delta: -(gauge - 70) / 12, color: SERIES.ingress, spark: bars.slice(-14).map((v) => 100 - v), icon: AlertTriangle },
  ];

  const days = Math.floor(uptimeSec / 86400);
  const hrs = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);

  const STATE = {
    ok:   { dot: "bg-emerald-400", text: "text-emerald-400", ring: "border-emerald-500/30 bg-emerald-500/10", label: "nominal" },
    warn: { dot: "bg-amber-400",   text: "text-amber-400",   ring: "border-amber-500/30 bg-amber-500/10",     label: "degraded" },
    crit: { dot: "bg-rose-500",    text: "text-rose-400",    ring: "border-rose-500/30 bg-rose-500/10",       label: "critical" },
  };

  return (
    <div className="relative min-h-screen pt-24 pb-16">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0">
        <div className="absolute left-1/4 top-0 h-96 w-96 rounded-full bg-rose-700/12 blur-[120px]" />
        <div className="absolute right-0 bottom-1/4 h-80 w-80 rounded-full bg-cyan-600/8 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Kicker>Telemetry demo</Kicker>
            <h1 className="mt-4 text-3xl font-black tracking-tighter text-white sm:text-4xl">Perimeter telemetry</h1>
            <p className="mt-1.5 text-sm text-slate-500">
              Simulated stream · 4Hz · every number here is generated in your browser. The
              real encrypted console lives at{" "}
              <a href={CONSOLE_URL} className="text-rose-400 underline decoration-rose-500/40 underline-offset-2 hover:text-rose-300">
                /app
              </a>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> mesh nominal
            </span>
            <span className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-[11px] text-slate-400">
              <Server className="h-3.5 w-3.5" /> uptime {days}d {hrs}h {String(mins).padStart(2, "0")}m
            </span>
          </div>
        </div>

        {/* stat tiles */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((t, i) => {
            const Icon = t.icon;
            const up = t.delta >= 0;
            return (
              <Glass key={t.label} style={{ animationDelay: `${i * 80}ms` }}
                className="group overflow-hidden p-5 transition-all duration-300 hover:-translate-y-1 hover:border-white/25 animate-[dp-rise_0.6s_ease-out_both]">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-widest text-slate-500">{t.label}</span>
                  <Icon className="h-4 w-4 text-slate-600 transition-colors duration-300 group-hover:text-slate-300" />
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-bold tabular-nums text-white">{t.value}</span>
                  <span className="text-[11px] text-slate-500">{t.unit}</span>
                </div>
                <div className="mt-1 flex items-center gap-1 text-[11px]">
                  <span className={up ? "text-emerald-400" : "text-rose-400"}>
                    {up ? "▲" : "▼"} {Math.abs(t.delta).toFixed(1)}
                  </span>
                  <span className="text-slate-600">vs last tick</span>
                </div>
                <div className="mt-3 -mx-1">
                  <Sparkline points={t.spark} color={t.color} />
                </div>
              </Glass>
            );
          })}
        </div>

        {/* main grid */}
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Glass className="p-5 sm:p-6 lg:col-span-2">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-white">Relay throughput</h2>
                <p className="text-[11px] text-slate-500">Last 60 seconds · hover for values</p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-slate-400">
                <Wifi className="h-3 w-3 text-rose-400" /> streaming
              </span>
            </div>
            <TelemetryChart series={series} reduced={reduced} />
          </Glass>

          <Glass className="flex flex-col items-center justify-center p-5 sm:p-6">
            <h2 className="mb-1 self-start text-sm font-semibold text-white">Mesh integrity</h2>
            <p className="mb-4 self-start text-[11px] text-slate-500">Composite of 42 relays</p>
            <Gauge value={gauge} label="Rolling 5-minute window" sublabel="score" />
            <div className="mt-5 grid w-full grid-cols-3 gap-2 border-t border-white/10 pt-4 text-center">
              {[["42", "relays"], ["9ms", "p50"], ["31ms", "p99"]].map(([v, k]) => (
                <div key={k}>
                  <p className="font-mono text-sm font-bold text-white">{v}</p>
                  <p className="text-[10px] uppercase tracking-widest text-slate-600">{k}</p>
                </div>
              ))}
            </div>
          </Glass>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Glass className="p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-white">Handshakes / sec</h2>
            <p className="mb-4 text-[11px] text-slate-500">14 intervals · hover a bar</p>
            <LoadBars bars={bars} />
          </Glass>

          <Glass className="overflow-hidden p-5 sm:p-6 lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Event stream</h2>
                <p className="text-[11px] text-slate-500">Tail · newest first</p>
              </div>
              <Terminal className="h-4 w-4 text-slate-600" />
            </div>
            <div className="dp-scroll max-h-56 space-y-1.5 overflow-y-auto pr-1 font-mono text-[11px]">
              {logs.map(({ l, k }) => {
                const [lvl, chan, msg] = l;
                const s = STATE[lvl] || STATE.ok;
                return (
                  <div key={k} className="flex items-start gap-3 rounded-lg border border-white/5 bg-black/40 px-3 py-2 animate-[dp-rise_0.4s_ease-out_both]">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
                    <span className={`w-24 shrink-0 truncate ${s.text}`}>{chan}</span>
                    <span className="min-w-0 flex-1 text-slate-400">{msg}</span>
                    <span className="shrink-0 text-slate-700">{String(k).padStart(4, "0")}</span>
                  </div>
                );
              })}
            </div>
          </Glass>
        </div>

        {/* node table */}
        <Glass className="mt-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Relay nodes</h2>
              <p className="text-[11px] text-slate-500">Availability by region</p>
            </div>
            <Database className="h-4 w-4 text-slate-600" />
          </div>
          <div className="dp-scroll overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-widest text-slate-500">
                  <th className="px-5 py-3 font-medium">Node</th>
                  <th className="px-5 py-3 font-medium">Region</th>
                  <th className="px-5 py-3 font-medium">Load</th>
                  <th className="px-5 py-3 font-medium">Latency</th>
                  <th className="px-5 py-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {NODES.map((n) => {
                  const s = STATE[n.state];
                  return (
                    <tr key={n.id} className="transition-colors duration-200 hover:bg-white/[0.04]">
                      <td className="px-5 py-3 font-mono text-xs text-white">{n.id}</td>
                      <td className="px-5 py-3 text-xs text-slate-400">{n.region}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                            <span className="block h-full rounded-full bg-rose-500 transition-all duration-1000 ease-out"
                              style={{ width: `${n.load}%` }} />
                          </span>
                          <span className="font-mono text-[11px] text-slate-400">{n.load}%</span>
                        </div>
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-300">{n.ms}ms</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${s.ring} ${s.text}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />{s.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Glass>

        <p className="mt-6 text-center text-[11px] text-slate-600">
          Every number above is generated on your device from a seeded PRNG. Nothing left the building.
          <span className="text-slate-700"> Nothing ever does.</span>
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------- root ---------------------------------- */

export default function DeadPoetPlatform() {
  const [view, setView] = useState("site");
  const [config, setConfig] = useState({
    threat: "syndicate",
    tier: "operator",
    seats: 24,
    retention: 30,
    annual: true,
    addons: ["pqc", "studio"],
  });
  const [cursor, setCursor] = useState({ x: -400, y: -400 });

  const onJump = useCallback((id) => {
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  useEffect(() => {
    const on = (e) => setCursor({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", on, { passive: true });
    return () => window.removeEventListener("pointermove", on);
  }, []);

  return (
    <div className="relative min-h-screen scroll-smooth bg-[#05060a] font-sans text-slate-200 antialiased selection:bg-rose-600 selection:text-white">
      <style>{KEYFRAMES}</style>

      {/* fixed atmosphere */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 0%, rgba(190,18,60,0.16), transparent 45%), radial-gradient(circle at 85% 30%, rgba(112,26,117,0.14), transparent 45%)",
          }} />
        <div className="absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.9) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.9) 1px, transparent 1px)",
            backgroundSize: "64px 64px",
          }} />
        {/* cursor spotlight */}
        <div className="absolute h-[520px] w-[520px] rounded-full transition-transform duration-300 ease-out"
          style={{
            transform: `translate(${cursor.x - 260}px, ${cursor.y - 260}px)`,
            background: "radial-gradient(circle, rgba(244,63,94,0.10), transparent 62%)",
          }} />
      </div>

      <Nav view={view} setView={setView} onJump={onJump} />

      <main className="relative z-10">
        {view === "site" ? (
          <div className="animate-[dp-rise_0.5s_ease-out_both]">
            <Hero onJump={onJump} />
            <Ticker />
            <Features />
            <Deploy config={config} setConfig={setConfig} />
            <Quotes />
            <Footer setView={setView} />
          </div>
        ) : (
          <div className="animate-[dp-rise_0.5s_ease-out_both]">
            <Dashboard config={config} />
          </div>
        )}
      </main>

      {/* mobile view switch */}
      <button
        onClick={() => { setView((v) => (v === "site" ? "dashboard" : "site")); window.scrollTo({ top: 0 }); }}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full
          bg-gradient-to-br from-rose-600 to-red-700 text-white shadow-[0_0_40px_-6px_rgba(244,63,94,1)]
          transition-transform duration-300 hover:scale-110 active:scale-95 sm:hidden"
        aria-label="Toggle telemetry demo"
      >
        {view === "site" ? <Activity className="h-6 w-6" /> : <Layers className="h-6 w-6" />}
      </button>
    </div>
  );
}
