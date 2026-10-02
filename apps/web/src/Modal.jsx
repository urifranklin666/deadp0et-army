import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";

/**
 * Replaces window.prompt/confirm/alert, which block the event loop, cannot be
 * styled, and in some browsers are suppressed entirely.
 */

export function Shell({ title, children, onClose }) {
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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[6px] animate-[dp-rise_0.12s_ease-out_both]" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-ink-850 p-5 shadow-lift
          ring-1 ring-black/40 animate-[dp-rise_0.15s_ease-out_both]"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-tight text-white">{title}</h2>
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
      <label className="mt-4 block text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">{label}</label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") go(); }}
        placeholder={placeholder}
        spellCheck={false}
        disabled={busy}
        className="mt-2 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2.5 font-mono text-sm text-white
          outline-none transition placeholder:text-slate-600 focus:border-rose-500/60 focus:ring-4 focus:ring-rose-500/10 disabled:opacity-50"
      />
      {hint ? <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{hint}</p> : null}
      {value && invalid ? <p className="mt-1.5 text-[11px] text-amber-400">{invalid}</p> : null}
      {err ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{err}</span>
        </div>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} disabled={busy}
          className="rounded-lg px-3 py-2 text-xs font-medium text-slate-400 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40">
          Cancel
        </button>
        <button onClick={go} disabled={busy || !value.trim() || !!invalid}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-b from-rose-500 to-rose-600 px-3.5 py-2
            text-xs font-semibold text-white shadow-glow transition hover:from-rose-400 hover:to-rose-500 disabled:opacity-40 disabled:shadow-none">
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
          className="rounded-lg px-3 py-2 text-xs font-medium text-slate-400 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40">
          Cancel
        </button>
        <button onClick={go} disabled={busy}
          className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition disabled:opacity-40
            ${danger ? "bg-gradient-to-b from-rose-500 to-rose-600 shadow-glow hover:from-rose-400" : "bg-white/10 hover:bg-white/15"}`}>
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
export function ChoiceModal({ title, header, body, choices, onClose }) {
  const [busy, setBusy] = useState(null);
  const pick = async (c) => {
    setBusy(c.label);
    // An onPick that returns false has opened something else; don't close over it.
    try { if ((await c.onPick()) !== false) onClose(); } catch { setBusy(null); }
  };
  return (
    <Shell title={title} onClose={busy ? () => {} : onClose}>
      {header}
      {body ? <p className="mt-3 text-xs leading-relaxed text-slate-400">{body}</p> : null}
      <div className="-mx-2 mt-3 flex flex-col">
        {choices.map((c, i) => {
          const Icon = c.icon;
          return (
            <React.Fragment key={c.label}>
              {c.divider ? <div className="mx-2 my-1.5 h-px bg-white/[0.06]" /> : null}
              <button onClick={() => pick(c)} disabled={!!busy}
                data-autofocus={(c.primary || (i === 0 && !choices.some((x) => x.primary))) ? "" : undefined}
                className={`group flex items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors
                  focus:outline-none focus-visible:bg-white/[0.06] disabled:opacity-40
                  ${c.danger ? "text-rose-300 hover:bg-rose-500/10" : "text-slate-200 hover:bg-white/[0.06]"}`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border
                  ${c.danger ? "border-rose-500/25 bg-rose-500/10 text-rose-400" : "border-white/[0.08] bg-white/[0.04] text-slate-400 group-hover:text-white"}`}>
                  {busy === c.label ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">{c.label}</span>
                  {c.hint ? <span className="block truncate text-[11px] text-slate-500">{c.hint}</span> : null}
                </span>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </Shell>
  );
}

/**
 * Jump to a channel by typing part of its name (Ctrl/⌘+K). Channels with
 * news come first; names that start with the query rank above ones that
 * merely contain it.
 */
export function SwitcherModal({ channels, unread, activeId, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [pick, setPick] = useState(0);
  const needle = q.trim().toLowerCase();
  const rank = (ch) => (needle && !ch.slug.startsWith(needle) ? 2 : 0) + (unread.has(ch.groupId) ? 0 : 1);
  const list = channels
    .filter((ch) => ch.slug.includes(needle))
    .map((ch, i) => ({ ch, i }))
    .sort((a, b) => rank(a.ch) - rank(b.ch) || a.i - b.i)
    .map(({ ch }) => ch)
    .slice(0, 8);
  const at = Math.min(pick, Math.max(0, list.length - 1));
  const go = (ch) => { if (ch) { onClose(); onPick(ch); } };
  return (
    <Shell title="Jump to a channel" onClose={onClose}>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setPick(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (list.length) setPick((at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
          }
          if (e.key === "Enter") { e.preventDefault(); go(list[at]); }
        }}
        placeholder="Channel name" aria-label="Channel name" spellCheck={false}
        role="combobox" aria-expanded="true" aria-controls="switcher-list" aria-autocomplete="list"
        aria-activedescendant={list[at] ? `switch-${list[at].id}` : undefined}
        className="mt-4 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2.5 font-mono text-sm text-white
          outline-none transition placeholder:text-slate-600 focus:border-rose-500/60 focus:ring-4 focus:ring-rose-500/10"
      />
      <ul id="switcher-list" role="listbox" aria-label="Channels" className="-mx-1 mt-2 flex flex-col">
        {list.length === 0 ? (
          <li className="px-3 py-2 text-xs text-slate-500">No channel matches “{q.trim()}”.</li>
        ) : list.map((ch, i) => (
          <li key={ch.id} id={`switch-${ch.id}`} role="option" aria-selected={i === at}
            onMouseDown={(e) => { e.preventDefault(); go(ch); }} onMouseMove={() => setPick(i)}
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm
              ${i === at ? "bg-white/[0.08] text-white" : "text-slate-400"}`}>
            <span className="text-slate-600">#</span>
            <span className={`min-w-0 truncate ${unread.has(ch.groupId) ? "font-semibold text-white" : ""}`}>{ch.slug}</span>
            {ch.id === activeId ? <span className="text-[11px] text-slate-500">open</span> : null}
            {unread.has(ch.groupId) ? (
              <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-label="unread" />
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10px] text-slate-600">↑↓ to choose · Enter to open · Esc to close</p>
    </Shell>
  );
}
