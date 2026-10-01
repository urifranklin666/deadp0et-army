import React from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from "lucide-react";

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
    primary: "bg-gradient-to-b from-rose-500 to-rose-600 text-white shadow-glow hover:from-rose-400 hover:to-rose-500 active:translate-y-px",
    ghost: "border border-white/10 bg-white/[0.04] text-slate-200 hover:border-white/20 hover:bg-white/[0.07] hover:text-white",
  };
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold
        transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/70
        focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950
        disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${skins[variant]} ${className}`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function Banner({ kind = "error", children, onClose }) {
  const skins = {
    error: "border-rose-500/30 bg-rose-500/[0.08] text-rose-100",
    info: "border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-100",
    ok: "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-100",
  };
  const Icon = { error: AlertTriangle, info: Info, ok: CheckCircle2 }[kind] || Info;
  const tint = { error: "text-rose-400", info: "text-cyan-300", ok: "text-emerald-400" }[kind];
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] leading-snug shadow-lift
      animate-[dp-rise_0.2s_ease-out_both] ${skins[kind]}`}>
      <Icon className={`mt-px h-4 w-4 shrink-0 ${tint}`} />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onClose ? (
        <button onClick={onClose} className="-m-1 shrink-0 rounded-md p-1 opacity-60 transition hover:bg-white/10 hover:opacity-100" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}


/** Initial in a circle, coloured from the name, so people are told apart at a glance. */
export function Avatar({ name, size = 28, className = "" }) {
  const n = name || "?";
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return (
    <span aria-hidden="true"
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold uppercase ${className}`}
      style={{
        width: size, height: size, fontSize: Math.round(size * 0.42),
        color: `hsl(${hue} 90% 80%)`, background: `hsl(${hue} 55% 22% / .9)`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 70% 60% / .25)`,
      }}>
      {n.replace(/[^a-z0-9]/gi, "").charAt(0) || "?"}
    </span>
  );
}
