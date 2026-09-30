import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";

/**
 * Replaces window.prompt/confirm/alert, which block the event loop, cannot be
 * styled, and in some browsers are suppressed entirely.
 */

function Shell({ title, children, onClose }) {
  const ref = useRef(null);

  // Mount-only: focus moves in once, and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement;
    // A text field if there is one, else the dialog's primary action. (Not
    // `querySelector("input, button")`: that returns the first match in
    // document order, which is the Close button in the header.)
    const el = ref.current;
    (el?.querySelector("input, textarea") || el?.querySelector("[data-autofocus]")
      || el?.querySelector("button"))?.focus();
    return () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      // Keep Tab inside the dialog: aria-modal promises the rest is inert.
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll("button, input, textarea, [href], [tabindex]:not([tabindex='-1'])")]
        .filter((n) => !n.disabled);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-sm rounded-xl border border-white/10 bg-[#0b0d13] p-5 shadow-2xl
          animate-[dp-rise_0.15s_ease-out_both]"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-white">{title}</h2>
          <button onClick={onClose} aria-label="Close"
            className="rounded p-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Text prompt. onSubmit may be async; errors render inline. */
export function PromptModal({ title, label, hint, placeholder, submitLabel = "Continue", validate, onSubmit, onClose }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const invalid = validate ? validate(value.trim()) : null;

  const go = async () => {
    if (invalid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (e) {
      setErr(e.message || String(e));
      setBusy(false);
    }
  };

  return (
    <Shell title={title} onClose={busy ? () => {} : onClose}>
      <label className="mt-4 block text-[11px] uppercase tracking-widest text-slate-500">{label}</label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") go(); }}
        placeholder={placeholder}
        spellCheck={false}
        disabled={busy}
        className="mt-2 w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 font-mono text-sm text-white
          outline-none transition-colors placeholder:text-slate-600 focus:border-rose-500/60 disabled:opacity-50"
      />
      {hint ? <p className="mt-1.5 text-[11px] text-slate-600">{hint}</p> : null}
      {value && invalid ? <p className="mt-1.5 text-[11px] text-amber-400">{invalid}</p> : null}
      {err ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{err}</span>
        </div>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} disabled={busy}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40">
          Cancel
        </button>
        <button onClick={go} disabled={busy || !value.trim() || !!invalid}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-rose-600 to-red-700 px-3 py-1.5
            text-xs font-semibold text-white disabled:opacity-40">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </Shell>
  );
}

/** Confirmation, used for destructive actions. */
export function ConfirmModal({ title, body, confirmLabel = "Confirm", danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); } catch { setBusy(false); }
  };
  return (
    <Shell title={title} onClose={busy ? () => {} : onClose}>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">{body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} disabled={busy}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40">
          Cancel
        </button>
        <button onClick={go} disabled={busy}
          className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40
            ${danger ? "bg-gradient-to-r from-rose-600 to-red-700" : "bg-white/10"}`}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {confirmLabel}
        </button>
      </div>
    </Shell>
  );
}

/**
 * Several labelled actions. Each onPick may be async; the dialog stays open
 * and busy until it settles, and closes itself only if the action succeeds.
 */
export function ChoiceModal({ title, body, choices, onClose }) {
  const [busy, setBusy] = useState(null);
  const pick = async (c) => {
    setBusy(c.label);
    // An onPick that returns false has opened something else; don't close over it.
    try { if ((await c.onPick()) !== false) onClose(); } catch { setBusy(null); }
  };
  return (
    <Shell title={title} onClose={busy ? () => {} : onClose}>
      {body ? <p className="mt-2 text-xs leading-relaxed text-slate-400">{body}</p> : null}
      <div className="mt-5 flex flex-col gap-2">
        {choices.map((c, i) => (
          <button key={c.label} onClick={() => pick(c)} disabled={!!busy} data-autofocus={i === 0 ? "" : undefined}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold
              transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-40
              ${c.primary ? "bg-rose-600 text-white hover:bg-rose-500" : "border border-white/15 bg-white/5 text-slate-200 hover:border-rose-500/50"}`}>
            {busy === c.label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {c.label}
          </button>
        ))}
      </div>
    </Shell>
  );
}
