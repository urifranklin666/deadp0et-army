import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Monitor, X } from "lucide-react";
import { Shell } from "./Modal.jsx";
import { api } from "./lib/api.js";
import { fmtTime } from "./ui.jsx";

/** "Chrome on macOS" from a user agent — a label for a person, not a check. */
export function describeAgent(ua) {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Every browser signed in to this account. A session you don't recognise can
 * be ended on its own; ending this one signs this browser out.
 */
export default function SessionsModal({ onClose }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => api.sessions().then((r) => setList(r.sessions)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const revoke = async (s) => {
    setBusy(s.id);
    setErr(null);
    try {
      await api.revokeSession(s.id);
      if (s.current) { location.reload(); return; }
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Shell title="Sessions" onClose={busy ? () => {} : onClose}>
      <p className="mt-3 text-xs leading-relaxed text-paper-dim">
        Every browser signed in to your account. End any you don't recognise.
      </p>
      {list === null ? (
        <Loader2 className="mx-auto mt-4 h-4 w-4 animate-spin text-dim" />
      ) : (
        <ul className="mt-4 space-y-1.5">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-2 border border-paper/20 px-3 py-2 text-xs">
              <Monitor className="h-3.5 w-3.5 shrink-0 text-dim" />
              <span className="min-w-0 flex-1 text-paper">
                {describeAgent(s.userAgent)}
                {s.current ? <span className="dp-tag ml-1.5 text-acid">this browser</span> : null}
                <span className="block font-mono text-[10px] text-dim">
                  signed in {fmtTime(s.createdAt)}{s.lastSeenAt ? ` · active ${fmtTime(s.lastSeenAt)}` : ""}
                </span>
              </span>
              <button aria-label={`End session: ${describeAgent(s.userAgent)}${s.current ? " (this browser)" : ""}`}
                disabled={!!busy} onClick={() => revoke(s)}
                className="p-1 text-dim transition-colors hover:bg-blood/15 hover:text-blood disabled:opacity-30">
                {busy === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {err ? <p className="mt-3 font-mono text-[11px] text-blood">{err}</p> : null}
    </Shell>
  );
}
