import React from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";

/* Shared console primitives. */

/** "14:05" today, "Mar 3 14:05" otherwise. */
export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function Glass({ className = "", children }) {
  const positioned = /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className);
  return (
    <div className={`${positioned ? "" : "relative "}rounded-xl border border-white/10 bg-white/[0.035] backdrop-blur-xl ${className}`}>
      {children}
    </div>
  );
}

export function Button({ children, icon: Icon, busy, variant = "primary", className = "", ...rest }) {
  const skins = {
    primary: "bg-gradient-to-r from-rose-600 to-red-700 text-white shadow-[0_0_30px_-10px_rgba(244,63,94,0.9)] hover:-translate-y-0.5",
    ghost: "border border-white/15 bg-white/5 text-slate-200 hover:border-rose-500/50 hover:text-white",
  };
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold
        transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400
        disabled:cursor-not-allowed disabled:opacity-40 ${skins[variant]} ${className}`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function Banner({ kind = "error", children, onClose }) {
  const skins = {
    error: "border-rose-500/40 bg-rose-950/40 text-rose-200",
    info: "border-cyan-500/30 bg-cyan-950/30 text-cyan-200",
    ok: "border-emerald-500/30 bg-emerald-950/30 text-emerald-200",
  };
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${skins[kind]}`}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onClose ? (
        <button onClick={onClose} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

