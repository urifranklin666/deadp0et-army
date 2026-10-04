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

/** A paper-framed window on the black stage, with the red offset the site uses. */
export function Glass({ className = "", children }) {
  const positioned = /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className);
  return (
    <div className={`${positioned ? "" : "relative "}border-2 border-paper bg-ink-900 shadow-hard-lg ${className}`}>
      {children}
    </div>
  );
}

/**
 * Buttons speak in mono caps, like the site's. Primary is paper with the red
 * offset; pressing it pushes the paper into its own shadow.
 */
export function Button({ children, icon: Icon, busy, variant = "primary", className = "", ...rest }) {
  const skins = {
    primary: `border-paper bg-paper text-ink-950 shadow-hard hover:bg-white
      active:translate-x-[2px] active:translate-y-[2px] active:shadow-hard-xs`,
    ghost: "border-paper/30 bg-transparent text-paper hover:border-paper hover:bg-paper/5",
    danger: `border-blood bg-blood text-ink-950 shadow-hard-paper hover:bg-[#ff4a3d]
      active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_#e9e4d8]`,
  };
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      className={`inline-flex items-center justify-center gap-2 border-2 px-3.5 py-2 font-mono text-[11px] font-semibold uppercase
        tracking-label transition-[transform,box-shadow,background-color,border-color,color] duration-100
        disabled:cursor-not-allowed disabled:border-paper/25 disabled:bg-transparent disabled:text-dim disabled:shadow-none
        disabled:active:translate-x-0 disabled:active:translate-y-0
        ${skins[variant]} ${className}`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" strokeWidth={2.25} /> : null}
      {children}
    </button>
  );
}

export function Banner({ kind = "error", children, onClose }) {
  const skins = {
    error: "border-blood text-paper",
    info: "border-ice text-paper",
    ok: "border-acid text-paper",
  };
  const Icon = { error: AlertTriangle, info: Info, ok: CheckCircle2 }[kind] || Info;
  const tint = { error: "text-blood", info: "text-ice", ok: "text-acid" }[kind];
  return (
    <div className={`flex items-start gap-2.5 border border-paper/20 border-l-4 bg-ink-900 px-3.5 py-2.5 text-[13px] leading-snug shadow-pop
      animate-[dp-rise_0.2s_ease-out_both] ${skins[kind]}`}>
      <Icon className={`mt-px h-4 w-4 shrink-0 ${tint}`} />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onClose ? (
        <button onClick={onClose} className="-m-1 shrink-0 p-1 text-dim transition hover:bg-paper/10 hover:text-paper" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Initial on a square, in one of the five brand inks, so people are told
 * apart at a glance without any colour the rest of the console doesn't use.
 */
const INKS = [
  ["#e9e4d8", "#070707"],   // paper
  ["#f03224", "#070707"],   // blood
  ["#d8ff38", "#070707"],   // acid
  ["#51e8df", "#070707"],   // ice
  ["#070707", "#e9e4d8"],   // black, paper letter
];
export function Avatar({ name, size = 28, className = "" }) {
  const n = name || "?";
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const [bg, fg] = INKS[h % INKS.length];
  return (
    <span aria-hidden="true"
      className={`inline-flex shrink-0 select-none items-center justify-center font-mono font-semibold uppercase ${className}`}
      style={{
        width: size, height: size, fontSize: Math.round(size * 0.46), lineHeight: 1,
        color: fg, background: bg, boxShadow: `inset 0 0 0 1px ${fg === "#070707" ? "rgba(7,7,7,.25)" : "rgba(233,228,216,.5)"}`,
      }}>
      {n.replace(/[^a-z0-9]/gi, "").charAt(0) || "?"}
    </span>
  );
}
