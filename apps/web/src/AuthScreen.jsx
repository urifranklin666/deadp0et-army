import React, { useState } from "react";
import { Atom, Fingerprint, KeyRound, Lock, ServerOff, Skull } from "lucide-react";
import { Banner, Button, Glass } from "./ui.jsx";
import { login, register } from "./lib/passkeys.js";

/* ------------------------------------------------------------- auth gate */

export default function AuthScreen({ onAuthed, bootError }) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(null);
  const [localErr, setLocalErr] = useState(null);
  // A failure *after* the passkey succeeds (device or key-package setup) must
  // not vanish just because we fell back to this screen.
  const err = localErr || bootError;
  const setErr = setLocalErr;

  const run = async (fn, mode) => {
    setErr(null);
    setBusy(mode);
    try {
      const res = await fn(handle.trim().toLowerCase());
      onAuthed(res.handle || handle.trim().toLowerCase());
    } catch (e) {
      // WebAuthn rejections are noisy DOMExceptions; make them legible.
      const msg = e.name === "NotAllowedError"
        ? "Passkey prompt dismissed or timed out."
        : e.message || String(e);
      setErr(msg);
    } finally {
      setBusy(null);
    }
  };

  const valid = /^[a-z0-9_]{3,32}$/.test(handle.trim().toLowerCase());

  return (
    <div className="dp-noise flex min-h-full items-center justify-center bg-ink-950 p-6 font-sans">
      {/* The site's red glow, top centre, nothing else. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10"
        style={{ background: "radial-gradient(60rem 40rem at 50% 0%, rgba(240,50,36,.12), transparent 70%)" }} />

      <div className="w-full max-w-md">
        <Glass>
          {/* The window bar from the hero on the site: the console is that window. */}
          <div className="flex h-10 items-center gap-2.5 bg-paper px-3 text-ink-950">
            <span className="dp-mark h-6 w-6"><Skull className="h-3.5 w-3.5" strokeWidth={2} /></span>
            <span className="font-display text-[13px] tracking-[-0.03em]">DEADP0ET.ARMY</span>
            <span className="dp-tag ml-auto text-ink-950/60">console / sign-in</span>
          </div>

          <div className="p-7">
            <p className="dp-eyebrow flex items-center gap-2 text-blood">
              <span className="h-2 w-2 bg-blood" aria-hidden="true" />Passkey only
            </p>
            <h1 className="mt-3 font-display text-[34px] leading-[0.95] tracking-[-0.04em] text-paper">
              The room<br />is waiting.
            </h1>
            <p className="mt-4 text-sm leading-relaxed text-paper-dim">
              There is no password to steal, phish, or reuse. Your handle and a passkey are the whole key.
            </p>

            <label htmlFor="handle" className="dp-eyebrow mt-7 block text-dim">
              Handle
            </label>
            <input
              id="handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && valid) run(login, "login"); }}
              placeholder="ghost_01"
              autoComplete="username webauthn"
              spellCheck={false}
              className="mt-2 w-full border-2 border-paper/30 bg-ink-950 px-3.5 py-3 font-mono text-sm text-paper
                outline-none transition-colors placeholder:text-dim/60 focus:border-paper"
            />
            <p className="dp-tag mt-2 text-dim">3–32 chars: a–z, 0–9, underscore</p>

            {err ? <div className="mt-4"><Banner onClose={() => setErr(null)}>{err}</Banner></div> : null}

            <div className="mt-6 flex gap-3">
              <Button icon={Fingerprint} busy={busy === "login"} disabled={!valid || busy}
                onClick={() => run(login, "login")} className="flex-1 !py-3">
                Sign in
              </Button>
              <Button icon={KeyRound} variant="ghost" busy={busy === "register"} disabled={!valid || busy}
                onClick={() => run(register, "register")} className="flex-1 !py-3">
                Create passkey
              </Button>
            </div>
          </div>

          {/* The protocol strip, as on the site: three facts, not three cards. */}
          <ul className="dp-tag flex flex-wrap items-center gap-x-4 gap-y-1 bg-acid px-4 py-2.5 font-semibold text-ink-950">
            {[[Lock, "End-to-end"], [Atom, "Post-quantum"], [ServerOff, "No server keys"]].map(([Icon, t], i) => (
              <li key={t} className="flex items-center gap-1.5">
                {i ? <span aria-hidden="true" className="mr-2.5 h-1.5 w-1.5 bg-ink-950/70" /> : null}
                <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />{t}
              </li>
            ))}
          </ul>
        </Glass>

        <p className="mt-7 font-mono text-[11px] leading-relaxed text-dim">
          Keys are generated on this device and never leave it. Clearing site data for this
          origin destroys your group history — we cannot restore it, which is rather the point.
        </p>
      </div>
    </div>
  );
}
