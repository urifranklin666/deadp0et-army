import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Shell } from "./Modal.jsx";
import { api } from "./lib/api.js";
import { addPasskey, withReauth } from "./lib/session.js";
import { fmtTime } from "./ui.jsx";

/**
 * The account's passkeys. Sign-in is passkey-only, so one passkey is one
 * point of loss; this is where a backup gets added. The last one can't be
 * removed (the server refuses too).
 */
export default function PasskeysModal({ onClose }) {
  const [keys, setKeys] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => api.passkeys().then((r) => setKeys(r.passkeys)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const run = async (what, fn) => {
    setBusy(what);
    setErr(null);
    try { await fn(); await load(); }
    catch (e) { setErr(e.name === "NotAllowedError" ? "Passkey prompt dismissed or timed out." : e.message); }
    finally { setBusy(null); }
  };

  return (
    <Shell title="Passkeys" onClose={busy ? () => {} : onClose}>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">
        Add a second passkey — another device, or a security key — so losing one doesn't lose the account.
      </p>
      {keys === null ? (
        <Loader2 className="mx-auto mt-4 h-4 w-4 animate-spin text-slate-500" />
      ) : (
        <ul className="mt-4 space-y-1.5">
          {keys.map((k, i) => (
            <li key={k.id} className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span className="min-w-0 flex-1 text-slate-300">
                Passkey {i + 1}
                <span className="block font-mono text-[10px] text-slate-500">
                  added {fmtTime(k.createdAt)}{k.lastUsedAt ? ` · last used ${fmtTime(k.lastUsedAt)}` : ""}
                </span>
              </span>
              <button aria-label={`Remove passkey ${i + 1}`} disabled={keys.length === 1 || !!busy}
                title={keys.length === 1 ? "Your only passkey can't be removed" : "Remove"}
                onClick={() => run(k.id, () => withReauth(() => api.removePasskey(k.id)))}
                className="rounded p-1 text-slate-500 hover:bg-rose-600/20 hover:text-rose-300 disabled:opacity-30">
                {busy === k.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {err ? <p className="mt-3 text-xs text-rose-300">{err}</p> : null}
      <button data-autofocus="" disabled={!!busy} onClick={() => run("add", addPasskey)}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm
          font-semibold text-white hover:bg-rose-500 disabled:opacity-40">
        {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Add a passkey
      </button>
    </Shell>
  );
}
