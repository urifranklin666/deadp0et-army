import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Hash, ChevronLeft, MessageSquare, PenLine, RefreshCw, Send, Shield, UserPlus, Users } from "lucide-react";
import Canvas from "./Canvas.jsx";
import { api } from "./lib/api.js";
import { Button, fmtTime } from "./ui.jsx";

export function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Shield className="mx-auto h-8 w-8 text-slate-700" />
        <p className="mt-3 text-sm text-slate-500">Pick a channel, or create one.</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
          Each channel is an MLS group. Messages are encrypted once for the whole group and the
          server stores only ciphertext it cannot read.
        </p>
      </div>
    </div>
  );
}

/**
 * Who is in the channel, per the server's roster. Refetched whenever the
 * epoch moves, since adds are commits. (This is membership of the channel,
 * i.e. who may fetch its ciphertext; who can decrypt is the MLS group.)
 */
function Members({ session, openModal, onError }) {
  const [members, setMembers] = useState(null);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (session.removed) return undefined;    // the roster is no longer ours to read
    let dead = false;
    api.members(session.channel.id)
      .then((r) => {
        if (dead) return;
        setMembers(r.members);
        // Our own role can change under us (promoted, demoted); the session
        // uses it to decide whether to reconcile leavers' leaves.
        const me = r.members.find((m) => m.handle === session.handle);
        if (me) session.channel.role = me.role;
      })
      .catch(() => { if (!dead) setMembers(null); });
    return () => { dead = true; };
  }, [session, session.channel.id, session.epoch, session.removed, refresh]);

  const setRole = async (handle, role) => {
    setBusy(handle);
    try { await api.setRole(session.channel.id, handle, role); setRefresh((n) => n + 1); }
    catch (e) { onError?.(e.message); }
    finally { setBusy(null); }
  };

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (!members || session.removed) return null;
  // The server enforces this too; here it only decides whether to offer it.
  const mine = members.find((m) => m.handle === session.handle);
  const canRemove = (m) => ["owner", "admin"].includes(mine?.role)
    && m.handle !== session.handle && m.role !== "owner" && !!session.client;
  const canSetRole = (m) => mine?.role === "owner" && m.role !== "owner";
  const action = "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-500 disabled:opacity-40";
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Members"
        className="flex items-center gap-1 rounded px-1.5 py-1 font-mono text-[11px] text-slate-400 hover:bg-white/5 hover:text-white">
        <Users className="h-3.5 w-3.5" />{members.length}
      </button>
      {open ? (
        <ul className="absolute right-0 top-full z-20 mt-1 max-h-72 min-w-[16rem] overflow-y-auto rounded-lg border
          border-white/10 bg-[#0b0d14] p-1 shadow-2xl">
          {members.map((m) => (
            <li key={m.handle} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono text-slate-200">{m.handle}</span>
              {m.role !== "member" ? (
                <span className="text-[10px] uppercase tracking-wider text-rose-400/80">{m.role}</span>
              ) : null}
              {canSetRole(m) ? (
                <button disabled={busy === m.handle}
                  onClick={() => setRole(m.handle, m.role === "admin" ? "member" : "admin")}
                  className={`${action} hover:bg-white/10 hover:text-white`}>
                  {m.role === "admin" ? "Revoke admin" : "Make admin"}
                </button>
              ) : null}
              {canRemove(m) ? (
                <button onClick={() => { setOpen(false); openModal({ kind: "remove", session, handle: m.handle }); }}
                  className={`${action} hover:bg-rose-600/20 hover:text-rose-300`}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
          {mine && mine.role !== "owner" && session.client ? (
            <li className="mt-1 border-t border-white/10 pt-1">
              <button onClick={() => { setOpen(false); openModal({ kind: "leave", session }); }}
                className="w-full rounded px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-rose-600/20 hover:text-rose-300">
                Leave channel
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

const PAGE = 200;

export default function Conversation({ session, onError, onChange, openModal, onBack }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(null);
  const [mode, setMode] = useState(session.channel.kind === "canvas" ? "canvas" : "chat");
  const endRef = useRef(null);
  // Render only the latest messages: every sync re-renders this list, and a
  // long-lived channel's full history would make each new message cost a
  // render of thousands of rows. Older ones are a click away.
  const [shown, setShown] = useState(PAGE);
  const hidden = Math.max(0, session.history.length - shown);
  const visible = hidden ? session.history.slice(hidden) : session.history;

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [session.history.length]);

  // A removed session keeps its transcript readable but can no longer act.
  const joined = !!session.client && !session.removed;

  const send = async () => {
    const text = draft.trim();
    if (!text || !joined) return;
    setBusy("send");
    setDraft("");
    try { await session.send(text); onChange(); }
    catch (e) { onError(e.message); setDraft(text); }
    finally { setBusy(null); }
  };

  const invite = () => openModal({ kind: "invite", session });

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2.5 sm:gap-3 sm:px-4">
        <button onClick={onBack} aria-label="Back to channels"
          className="-ml-1 rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white md:hidden">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <Hash className="hidden h-4 w-4 shrink-0 text-slate-600 sm:block" />
        <span className="min-w-0 truncate text-sm font-semibold text-white">{session.channel.slug}</span>
        <span className="hidden shrink-0 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 sm:inline">
          epoch {session.epoch ?? "—"}
        </span>

        <div className="flex shrink-0 rounded-lg border border-white/10 bg-white/5 p-0.5 sm:ml-4">
          {[["chat", "Chat", MessageSquare], ["canvas", "Canvas", PenLine]].map(([id, label, Icon]) => (
            <button key={id} onClick={() => setMode(id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors
                ${mode === id ? "bg-rose-600 text-white" : "text-slate-400 hover:text-white"}`}>
              <Icon className="h-3 w-3" /><span className="sr-only sm:not-sr-only">{label}</span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <Members session={session} openModal={openModal} onError={onError} />
          <button onClick={async () => { try { await session.sync(); onChange(); } catch (e) { onError(e.message); } }}
            className="rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-white" aria-label="Sync">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <Button icon={UserPlus} variant="ghost" disabled={!joined}
            onClick={invite} className="!px-2 !py-1.5 !text-xs sm:!px-3">
            <span className="sr-only sm:not-sr-only">Invite</span>
          </Button>
        </div>
      </div>

      {mode === "canvas" ? <Canvas session={session} onError={onError} openModal={openModal} /> : (
      <>
      <div className="dp-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!session.client && !session.removed ? (
          <p className="mx-auto max-w-sm text-center text-[11px] leading-relaxed text-slate-600">
            This device isn't a member yet. Once someone invites you, the Welcome arrives on the
            next poll and history starts from that point — earlier traffic stays unreadable, by design.
            If another of your devices is in this channel, invite your own handle from there.
          </p>
        ) : session.history.length === 0 ? (
          <p className="mx-auto max-w-sm text-center text-[11px] text-slate-600">
            Nothing here yet. Say something unwise.
          </p>
        ) : (
          <ul className="space-y-2">
            {hidden ? (
              <li className="text-center">
                <button onClick={() => setShown((n) => n + PAGE)}
                  className="rounded-md border border-white/10 px-3 py-1 text-[11px] text-slate-400 hover:text-white">
                  Show {Math.min(PAGE, hidden)} earlier message{Math.min(PAGE, hidden) === 1 ? "" : "s"}
                </button>
              </li>
            ) : null}
            {visible.map((m, i) => (
              // seq alone isn't unique: notices reuse the seq of the message
              // they follow.
              <li key={`${m.seq}:${m.notice ? "n" : m.audit ? "a" : m.error ? "e" : "m"}:${hidden + i}`}
                className="animate-[dp-rise_0.25s_ease-out_both]">
                {m.audit ? (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      {m.from || "someone"}{m.claimed ? ` (claiming to be ${m.claimed})` : ""} removed {m.audit.removed.join(", ")} from the group
                    </span>
                  </div>
                ) : m.notice ? (
                  <div className="flex items-start gap-2 rounded-lg border border-cyan-500/25 bg-cyan-950/20 px-3 py-2 text-[11px] text-cyan-200">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{m.notice}</span>
                  </div>
                ) : m.error ? (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>seq {m.seq}: undecryptable — {m.error}</span>
                  </div>
                ) : (
                  <div className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm
                      ${m.mine ? "bg-rose-600/25 text-rose-50" : "border border-white/10 bg-white/[0.04] text-slate-200"}`}>
                      {!m.mine && m.from ? (
                        <p className="mb-0.5 font-mono text-[10px] font-semibold text-cyan-300/80">
                          {m.from}
                          {m.unverified ? (
                            <span className="ml-1 text-amber-400" title="No account has registered the key that signed this">(unverified)</span>
                          ) : null}
                          {m.claimed ? (
                            <span className="ml-1 text-amber-400" title="The sender's credential names someone else">claims to be {m.claimed}</span>
                          ) : null}
                        </p>
                      ) : null}
                      <p className="whitespace-pre-wrap break-words">{m.text}</p>
                      <p className="mt-1 font-mono text-[9px] text-slate-500">
                        {m.at ? <time dateTime={m.at} title={new Date(m.at).toLocaleString()}>{fmtTime(m.at)}</time> : null}
                        {m.at ? " · " : null}#{m.seq}
                      </p>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-white/10 p-3">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={draft}
            disabled={!joined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={joined
              // The full line wraps (and clips) in a one-row box on a phone.
              ? (window.matchMedia?.("(max-width: 639px)").matches ? "Encrypted before it leaves…" : "Encrypted before it leaves this tab…")
              : session.removed ? "Removed from this channel" : "Not a member yet"}
            className="dp-scroll max-h-32 min-h-[38px] flex-1 resize-none rounded-lg border border-white/10 bg-black/50
              px-3 py-2 text-sm text-white outline-none transition-colors placeholder:text-slate-600
              focus:border-rose-500/60 disabled:opacity-50"
          />
          <Button icon={Send} busy={busy === "send"} disabled={!joined || !draft.trim()} onClick={send}>
            Send
          </Button>
        </div>
      </div>
      </>
      )}
    </>
  );
}
