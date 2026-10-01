import React, { useEffect, useState } from "react";
import {
  ArrowDown, ArrowUpRight, Check, EyeOff, Fingerprint, KeyRound, Lock,
  Menu, MessageSquare, PenTool, Radio, Skull, Terminal,
  Users, X, Zap,
} from "lucide-react";

const CONSOLE_URL = "/app/";

const proof = [
  ["IDENTITY", "Passkeys", "No passwords to phish, paste, reuse, or reset."],
  ["GROUP CIPHER", "Post-quantum MLS", "ML-KEM1024 + ML-DSA87. One encrypted message for the whole room."],
  ["SERVER VIEW", "Opaque ciphertext", "The relay stores public key material and bytes it cannot decrypt."],
  ["PRESENCE", "Ephemeral + sealed", "Cursor traffic is encrypted, relayed live, and never written to the log."],
];

const flow = [
  { n: "01", icon: Fingerprint, title: "Make a passkey", copy: "Your device becomes the credential. No email-and-password ceremony." },
  { n: "02", icon: Users, title: "Open a room", copy: "Invite another device into an MLS group with a cryptographic Welcome." },
  { n: "03", icon: PenTool, title: "Write in the dark", copy: "Chat, draw, and move together. The server only sees ciphertext." },
];

function Mark() {
  return <span className="mark" aria-hidden="true"><Skull /><i /></span>;
}

function Nav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="nav-shell">
      <a className="brand" href="#top" aria-label="Deadp0et Army home"><Mark /><b>DEADP0ET</b><span>.ARMY</span></a>
      <nav className={open ? "nav-links open" : "nav-links"} aria-label="Primary navigation">
        <a href="#proof" onClick={() => setOpen(false)}>proof</a>
        <a href="#surface" onClick={() => setOpen(false)}>surface</a>
        <a href="#protocol" onClick={() => setOpen(false)}>protocol</a>
        <a className="nav-console" href={CONSOLE_URL}>Open console <ArrowUpRight /></a>
      </nav>
      <button className="menu" aria-label="Toggle menu" onClick={() => setOpen(v => !v)}>{open ? <X /> : <Menu />}</button>
    </header>
  );
}

function Scribble() {
  return (
    <svg className="scribble" viewBox="0 0 900 620" role="img" aria-label="Encrypted collaborative canvas preview">
      <defs>
        <filter id="rough"><feTurbulence baseFrequency=".018 .09" numOctaves="2" seed="5" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="5"/></filter>
      </defs>
      <path d="M78 430C163 202 315 108 470 155c136 41 191 226 340 264" fill="none" stroke="currentColor" strokeWidth="16" filter="url(#rough)"/>
      <path d="M174 377c85-110 204-139 316-78 84 45 124 115 212 93" fill="none" stroke="currentColor" strokeWidth="5" opacity=".55"/>
      <circle cx="482" cy="277" r="118" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="9 12"/>
      <path d="m430 302 51-104 64 105-56-25z" fill="currentColor" opacity=".9"/>
      <path d="M110 491h608M148 523h421" stroke="currentColor" strokeWidth="3" opacity=".28"/>
    </svg>
  );
}

function Hero() {
  return (
    <section className="hero" id="top">
      <div className="hero-noise" />
      <div className="hero-copy">
        <p className="eyebrow"><i /> PRIVATE COLLABORATION / PUBLIC PROTOCOLS</p>
        <h1><span>MAKE</span><span>SECRETS.</span></h1>
        <p className="hero-lede">A shared design surface welded to end-to-end encrypted rooms. Draw together. Talk together. Leave the server with nothing worth stealing.</p>
        <div className="hero-actions">
          <a className="button primary" href={CONSOLE_URL}><Zap /> Open the console <ArrowUpRight /></a>
          <a className="button secondary" href="#proof">Show me the proof <ArrowDown /></a>
        </div>
        <p className="warning"><span>⚠</span> EXPERIMENTAL / NOT AUDITED / DO NOT BET A LIFE ON IT</p>
      </div>
      <div className="hero-visual" aria-hidden="true">
        <div className="canvas-window">
          <div className="window-bar"><span>ROOM / THE_RAVEN</span><span>3 PRESENT · EPOCH 07</span></div>
          <Scribble />
          <span className="cursor c1">URI</span><span className="cursor c2">GHOST_02</span>
          <p className="canvas-note">THE SERVER<br/>CAN'T READ<br/>THE ROOM.</p>
        </div>
        <div className="seal"><Lock /><span>MLS_256<br/>SEALED</span></div>
      </div>
      <div className="hero-index"><b>DP/A</b><span>FIELD NOTE 001</span><span>2026 — ∞</span></div>
    </section>
  );
}

function Proof() {
  const [active, setActive] = useState(1);
  return (
    <section className="proof section" id="proof">
      <header className="section-head"><p>01 / TRUST MODEL</p><h2>DON'T TRUST<br/>THE SERVER.</h2><span>That includes ours.</span></header>
      <div className="proof-layout">
        <div className="proof-list">
          {proof.map(([k, t, d], i) => (
            <button key={k} className={active === i ? "active" : ""} onClick={() => setActive(i)}>
              <span>{String(i + 1).padStart(2,"0")}</span><div><small>{k}</small><b>{t}</b></div><ArrowUpRight />
            </button>
          ))}
        </div>
        <div className="proof-card">
          <div className="proof-glyph">{active === 0 ? <Fingerprint/> : active === 1 ? <KeyRound/> : active === 2 ? <EyeOff/> : <Radio/>}</div>
          <p>{proof[active][0]}</p><h3>{proof[active][1]}</h3><div className="redact"><i/><i/><i/></div><p className="proof-desc">{proof[active][2]}</p>
          <div className="proof-status"><Check /> CLAIM MATCHES IMPLEMENTATION</div>
        </div>
      </div>
    </section>
  );
}

function Surface() {
  return (
    <section className="surface" id="surface">
      <div className="surface-copy">
        <p>02 / THE SURFACE</p><h2>MESSAGES<br/>WITH<br/><em>SHAPES.</em></h2>
        <p className="surface-lede">The canvas and the conversation belong to the same encrypted room. Strokes converge through Yjs. Messages advance the MLS ratchet. Cursors vanish when you do.</p>
        <ul><li><Check/> multiplayer drawing</li><li><Check/> encrypted room chat</li><li><Check/> live sealed presence</li><li><Check/> local device history</li></ul>
        <a href={CONSOLE_URL}>Draw something incriminating <ArrowUpRight/></a>
      </div>
      <div className="surface-stage">
        <div className="stage-tools"><PenTool/><span/><span/><span/><MessageSquare/></div>
        <Scribble />
        <div className="stage-chat"><p><b>GHOST_02</b><span>03:33</span></p><p>move the eye left.</p><p><b>URI</b><span>03:34</span></p><p>the eye moves itself.</p></div>
        <span className="cursor c3">YOU</span>
      </div>
    </section>
  );
}

function Protocol() {
  return (
    <section className="protocol section" id="protocol">
      <header className="section-head"><p>03 / HOW IT MOVES</p><h2>THREE STEPS.<br/>ZERO PLAINTEXT.</h2><span>In theory. Read the warning.</span></header>
      <div className="flow">
        {flow.map(({n,icon:Icon,title,copy}) => <article key={n}><span>{n}</span><Icon/><h3>{title}</h3><p>{copy}</p></article>)}
      </div>
      <div className="protocol-strip">
        <Terminal/><code>passkey → key package → MLS welcome → encrypted room → local transcript</code><span>SERVER: BLIND</span>
      </div>
    </section>
  );
}

function Manifesto() {
  return (
    <section className="manifesto">
      <p>THE SHORT VERSION</p>
      <h2>YOUR WORK<br/>IS NOT<br/><span>OUR DATA.</span></h2>
      <div><p>We built a server that is useful precisely because it knows less.</p><p>The cryptography uses vetted implementations. The composition has not been externally audited. Honesty is part of the threat model.</p></div>
    </section>
  );
}

function Footer() {
  return (
    <footer>
      <div className="footer-cta"><p>THE ROOM IS WAITING.</p><a href={CONSOLE_URL}>OPEN CONSOLE <ArrowUpRight/></a></div>
      <div className="footer-bottom"><a className="brand" href="#top"><Mark/><b>DEADP0ET</b><span>.ARMY</span></a><p>EXPERIMENTAL ENCRYPTED COLLABORATION · 2026</p><p>NO TRACKERS · NO PASSWORDS · NO PROMISES WE CAN'T PROVE</p></div>
    </footer>
  );
}

export default function DeadPoetPlatform() {
  useEffect(() => {
    const move = e => document.documentElement.style.setProperty("--mx", `${e.clientX}px`);
    addEventListener("pointermove", move, { passive:true });
    return () => removeEventListener("pointermove", move);
  }, []);
  return <div className="site"><Nav/><main><Hero/><Proof/><Surface/><Protocol/><Manifesto/></main><Footer/></div>;
}
