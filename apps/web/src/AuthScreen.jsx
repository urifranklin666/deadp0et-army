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
    <div className="dp-grid flex min-h-full items-center justify-center bg-ink-950 p-6 font-sans">
      <div aria-hidden className="pointer-events-none fixed inset-0">
        <div className="absolute -left-24 top-10 h-96 w-96 rounded-full bg-rose-600/15 blur-[130px]" />
        <div className="absolute -right-24 bottom-10 h-96 w-96 rounded-full bg-fuchsia-600/10 blur-[130px]" />
      </div>

      <Glass className="w-full max-w-md bg-ink-850/70 p-8 shadow-lift">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-600/10">
            <Skull className="h-5 w-5 text-rose-400" strokeWidth={1.75} />
          </span>
          <span className="text-sm font-black tracking-[0.2em] text-white">
            DEADP0ET<span className="text-rose-500">.ARMY</span>
          </span>
        </div>

        <h1 className="mt-7 text-[26px] font-bold tracking-tight text-white">Console access</h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Passkey only. There is no password to steal, phish, or reuse.
        </p>

        <label htmlFor="handle" className="mt-7 block text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">
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
          className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950 px-3.5 py-3 font-mono text-sm text-white
            outline-none transition placeholder:text-slate-600 focus:border-rose-500/60 focus:ring-4 focus:ring-rose-500/10"
        />
        <p className="mt-2 text-[11px] text-slate-500">3–32 chars: a–z, 0–9, underscore.</p>

        {err ? <div className="mt-4"><Banner onClose={() => setErr(null)}>{err}</Banner></div> : null}

        <div className="mt-6 flex gap-2">
          <Button icon={Fingerprint} busy={busy === "login"} disabled={!valid || busy}
            onClick={() => run(login, "login")} className="flex-1 !rounded-xl !py-2.5">
            Sign in
          </Button>
          <Button icon={KeyRound} variant="ghost" busy={busy === "register"} disabled={!valid || busy}
            onClick={() => run(register, "register")} className="flex-1 !rounded-xl !py-2.5">
            Create passkey
          </Button>
        </div>

        <ul className="mt-6 grid grid-cols-3 gap-2">
          {[[Lock, "End-to-end"], [Atom, "Post-quantum"], [ServerOff, "No server keys"]].map(([Icon, t]) => (
            <li key={t} className="flex flex-col items-center gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-2 py-2.5 text-[11px] text-slate-400">
              <Icon className="h-4 w-4 text-rose-400/80" />{t}
            </li>
          ))}
        </ul>

        <p className="mt-5 border-t border-white/[0.07] pt-4 text-[11px] leading-relaxed text-slate-500">
          Keys are generated on this device and never leave it. Clearing site data for this
          origin destroys your group history — we cannot restore it, which is rather the point.
        </p>
      </Glass>
    </div>
  );
}
