import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Hash, Info, Lock, Pencil, Reply, SmilePlus, Trash2, ChevronLeft, MessageSquare, PenLine, RefreshCw, Search, Send, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import Canvas from "./Canvas.jsx";
import { api } from "./lib/api.js";
import { Presence } from "./lib/presence.js";
import { REACTIONS, groupsWith } from "./lib/transcript.js";
import { RichText, mentionsIn } from "./lib/format.jsx";
import { Avatar, Button, fmtTime } from "./ui.jsx";

export function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-md">
        <div className="relative mx-auto flex h-20 w-20 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-rose-500/10 blur-xl" />
          <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-ink-850 shadow-lift">
            <ShieldCheck className="h-7 w-7 text-rose-400" strokeWidth={1.5} />
          </span>
        </div>
        <h2 className="mt-6 text-lg font-semibold tracking-tight text-white">Pick a channel, or create one.</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Each channel is an MLS group. Messages are encrypted once for the whole group and the
          server stores only ciphertext it cannot read.
        </p>
        <div className="mt-6 grid grid-cols-3 gap-2 text-left">
          {[["Post-quantum", "ML-KEM-1024 key exchange, ML-DSA-87 signatures"],
            ["Forward secret", "Keys ratchet; old messages stay sealed"],
            ["Passkey only", "Nothing to phish or reuse"]].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
              <p className="text-xs font-semibold text-slate-200">{t}</p>
              <p className="mt-1 text-[11px] leading-snug text-slate-500">{d}</p>
            </div>
          ))}
        </div>
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
  const action = "rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500 transition disabled:opacity-40";
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Members" title="Members"
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition
          ${open ? "bg-white/[0.08] text-white" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}>
        <Users className="h-4 w-4" />{members.length}
      </button>
      {open ? (
        <ul className="dp-scroll absolute right-0 top-full z-30 mt-2 max-h-80 w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border
          border-white/10 bg-ink-850 p-1.5 shadow-lift animate-[dp-rise_0.12s_ease-out_both]">
          <li className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500" aria-hidden="true">
            {members.length} member{members.length === 1 ? "" : "s"}
          </li>
          {members.map((m) => (
            <li key={m.handle} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs hover:bg-white/[0.04]">
              <Avatar name={m.handle} size={24} />
              <span className="min-w-0 flex-1 truncate font-mono text-slate-200">
                {m.handle}{m.handle === session.handle ? <span className="ml-1 font-sans text-slate-500">(you)</span> : null}
              </span>
              {m.role !== "member" ? (
                <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-rose-300">{m.role}</span>
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
            <li className="mt-1.5 border-t border-white/[0.07] pt-1.5">
              <button onClick={() => { setOpen(false); openModal({ kind: "leave", session }); }}
                className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-rose-300/80 transition hover:bg-rose-500/10 hover:text-rose-300">
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

/** Centered explainer for an empty or unavailable transcript. */
function Placeholder({ icon: Icon, title, children }) {
  return (
    <div className="mx-auto mt-16 max-w-sm text-center">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-ink-850">
        <Icon className="h-5 w-5 text-slate-500" />
      </span>
      {title ? <p className="mt-4 text-sm font-semibold text-slate-200">{title}</p> : null}
      <p className={`${title ? "mt-1" : "mt-4"} text-xs leading-relaxed text-slate-500`}>{children}</p>
    </div>
  );
}

/** A line from the client itself (not a member): notices, audits, failures. */
function SystemLine({ tone, icon: Icon, children }) {
  const skin = tone === "amber"
    ? "border-amber-400/20 bg-amber-400/[0.06] text-amber-200"
    : "border-cyan-400/15 bg-cyan-400/[0.05] text-cyan-200";
  return (
    <div className="flex justify-center">
      <div className={`flex max-w-xl items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed ${skin}`}>
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-80" />
        <span>{children}</span>
      </div>
    </div>
  );
}

/** Does a transcript entry match a (lower-cased) search? Text and sender only. */
const matches = (m, q) => m.text !== undefined
  && (m.text.toLowerCase().includes(q) || (m.from || "").toLowerCase().includes(q));

/** "Today", "Yesterday", or the date, for a day separator. */
function dayLabel(at) {
  const d = new Date(at);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}
const dayOf = (m) => (m.at ? new Date(m.at).toDateString() : null);

/** "alice is typing…", "alice and bob are typing…", "4 people are typing…" */
function typingLine(handles) {
  if (!handles.length) return "";
  if (handles.length === 1) return `${handles[0]} is typing…`;
  if (handles.length === 2) return `${handles[0]} and ${handles[1]} are typing…`;
  return `${handles.length} people are typing…`;
}

/** `text` with each occurrence of `q` wrapped in <mark>. */
function Highlight({ text, q }) {
  const lower = text.toLowerCase();
  // Lower-casing can change a string's length ("İ"); offsets would then be
  // wrong, so show such text unmarked rather than mismarked.
  if (!q || lower.length !== text.length) return text;
  const out = [];
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(<mark key={i} className="rounded-sm bg-amber-400/30 text-inherit">{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  out.push(text.slice(at));
  return out;
}

export default function Conversation({ session, onError, onChange, openModal, onBack }) {
  const [confirmDelete, setConfirmDelete] = useState(null);    // seq awaiting a second click
  const [draft, setDraftState] = useState(() => session.draft || "");
  // Replying to, or editing, one message. While editing, the composer holds
  // that message's text and the saved draft is set aside until it's done.
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const setAside = useRef("");
  const composer = useRef(null);
  const setDraft = (text) => { setDraftState(text); if (!editing) session.saveDraft(text); };
  const startReply = (m) => { if (editing) stopEditing(); setReplyTo(m); composer.current?.focus(); };

  // Reactions: one picker open at a time, keyed by the message's seq.
  const [picker, setPicker] = useState(null);
  const myKey = session.client?.ownKey?.() || null;
  useEffect(() => {
    if (picker === null) return undefined;
    const close = (e) => { if (!e.target.closest?.("[data-picker]")) setPicker(null); };
    const esc = (e) => { if (e.key === "Escape") setPicker(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [picker]);
  const react = async (seq, emoji, on) => {
    setPicker(null);
    try { await session.react(seq, emoji, on); onChange(); }
    catch (e) { onError(e.message); }
  };

  // @mention suggestions, from the channel roster, for the word at the caret.
  const [roster, setRoster] = useState([]);
  useEffect(() => {
    if (session.removed) return undefined;
    let dead = false;
    api.members(session.channel.id).then((r) => { if (!dead) setRoster(r.members.map((m) => m.handle)); }).catch(() => {});
    return () => { dead = true; };
  }, [session, session.channel.id, session.epoch, session.removed]);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [mentionOff, setMentionOff] = useState(false);
  const typed = /(?:^|\s)@([a-z0-9_]{0,32})$/i.exec(draft.slice(0, caret));
  const suggestions = typed && !mentionOff
    ? roster.filter((h) => h !== session.handle && h.startsWith(typed[1].toLowerCase())).slice(0, 6)
    : [];
  const caretAfterRender = useRef(null);
  useLayoutEffect(() => {
    if (caretAfterRender.current === null || !composer.current) return;
    composer.current.setSelectionRange(caretAfterRender.current, caretAfterRender.current);
    caretAfterRender.current = null;
  }, [draft]);
  const completeMention = (handle) => {
    const before = draft.slice(0, caret).replace(/@[a-z0-9_]*$/i, `@${handle} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setCaret(before.length);
    setPick(0);
    // Put the caret after the completed mention as soon as React has written
    // the new text, before any further keystroke is handled. (Deferring it to
    // a later frame let fast typing land, then yanked the caret back.)
    caretAfterRender.current = before.length;
    composer.current?.focus();
  };
  const startEdit = (m) => {
    setReplyTo(null);
    if (!editing) setAside.current = draft;
    setEditing(m);
    setDraftState(m.text);
    caretAfterRender.current = m.text.length;
    composer.current?.focus();
  };
  const stopEditing = () => { setEditing(null); setDraftState(setAside.current); };
  const [busy, setBusy] = useState(null);
  const [mode, setMode] = useState(session.channel.kind === "canvas" ? "canvas" : "chat");
  const endRef = useRef(null);
  // Render only the latest messages: every sync re-renders this list, and a
  // long-lived channel's full history would make each new message cost a
  // render of thousands of rows. Older ones are a click away.
  const [shown, setShown] = useState(PAGE);
  // Search runs over the decrypted transcript on this device; the query
  // never leaves it (the server only has ciphertext to search anyway).
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const q = searching ? query.trim().toLowerCase() : "";
  const source = q ? session.history.filter((m) => matches(m, q)) : session.history;
  const hidden = Math.max(0, source.length - shown);
  const visible = hidden ? source.slice(hidden) : source;
  const closeSearch = () => { setSearching(false); setQuery(""); setShown(PAGE); };

  // Follow new messages only while the reader is at the bottom (or the new
  // message is their own). Someone reading back through history isn't
  // yanked down by every arrival; they get a "new messages" button instead.
  const scrollRef = useRef(null);
  const atBottom = useRef(true);
  const seenLen = useRef(session.history.length);
  const [unseen, setUnseen] = useState(0);
  const toEnd = () => { endRef.current?.scrollIntoView({ block: "end" }); setUnseen(0); };
  const onScroll = () => {
    const el = scrollRef.current;
    atBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) setUnseen(0);
  };
  useEffect(() => {
    const len = session.history.length;
    const added = len - seenLen.current;
    seenLen.current = len;
    if (atBottom.current || added <= 0 || session.history[len - 1]?.mine) toEnd();
    else setUnseen((n) => n + added);
  }, [session.history.length, session.history]);
  useEffect(() => { toEnd(); }, [q]);

  // Clicking a reply's quote brings the quoted message into view and
  // flashes it, loading earlier history (and leaving search) if need be.
  const [flash, setFlash] = useState(null);
  const jumpTo = (seq) => {
    const at = session.history.findIndex((h) => h.seq === seq && (h.text !== undefined || h.deleted));
    if (at === -1) return;
    if (searching) { setSearching(false); setQuery(""); }
    setShown((n) => Math.max(n, PAGE, session.history.length - at));
    setFlash({ seq, n: Date.now() });     // a fresh object re-runs the effect on a repeat click
  };
  useEffect(() => {
    if (!flash) return undefined;
    scrollRef.current?.querySelector(`[data-seq="${flash.seq}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  // A removed session keeps its transcript readable but can no longer act.
  const joined = !!session.client && !session.removed;

  // Who else is typing, over the sealed presence relay (never the MLS log).
  // The canvas runs its own presence for cursors; chat needs one only while
  // it's showing. `joined` is a dep: presence needs the group's keys.
  const presence = useRef(null);
  const [typers, setTypers] = useState([]);
  useEffect(() => {
    if (mode !== "chat" || !joined) return undefined;
    const p = new Presence(session);
    p.onChange = () => {
      const handles = [...new Set([...p.typers.values()].map((t) => t.handle))]
        .filter((h) => h && h !== session.handle);
      setTypers((old) => (old.join("\n") === handles.join("\n") ? old : handles));
    };
    p.connect();
    presence.current = p;
    return () => { p.close(); presence.current = null; setTypers([]); };
  }, [session, mode, joined]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !joined) return;
    setBusy("send");
    presence.current?.typing(false);
    if (editing) {
      try { await session.editMessage(editing.seq, text); stopEditing(); onChange(); }
      catch (e) { onError(e.message); }
      finally { setBusy(null); }
      return;
    }
    const answering = replyTo;
    setDraft("");
    setReplyTo(null);
    try { await session.send(text, answering?.seq); onChange(); }
    catch (e) { onError(e.message); setDraft(text); setReplyTo(answering); }
    finally { setBusy(null); }
  };

  // Messages by seq, for reply quotes; built only if something on screen quotes.
  let bySeq = null;
  const quoted = (seq) => (bySeq ??= new Map(session.history
    .filter((h) => h.text !== undefined || h.deleted).map((h) => [h.seq, h]))).get(seq);
  const snippet = (t) => (t.length > 80 ? t.slice(0, 80) + "…" : t);

  const invite = () => openModal({ kind: "invite", session });

  const remove = async (seq) => {
    if (confirmDelete !== seq) { setConfirmDelete(seq); return; }
    setConfirmDelete(null);
    try { await session.deleteMessage(seq); onChange(); }
    catch (e) { onError(e.message); }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2.5 sm:gap-3 sm:px-5">
        <button onClick={onBack} aria-label="Back to channels"
          className="-ml-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/[0.06] hover:text-white md:hidden">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <Hash className="hidden h-5 w-5 shrink-0 text-rose-400/80 sm:block" />
        <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-white">{session.channel.slug}</span>
        <span title="MLS epoch: advances with every membership change and key update"
          className="hidden shrink-0 items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] text-slate-500 sm:inline-flex">
          <Lock className="h-2.5 w-2.5" /><span>epoch {session.epoch ?? "—"}</span>
        </span>

        <div className="flex shrink-0 rounded-lg border border-white/[0.08] bg-ink-900 p-0.5 sm:ml-3" role="group" aria-label="View">
          {[["chat", "Chat", MessageSquare], ["canvas", "Canvas", PenLine]].map(([id, label, Icon]) => (
            <button key={id} onClick={() => setMode(id)} aria-pressed={mode === id}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition
                ${mode === id ? "bg-white/[0.1] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.06)]" : "text-slate-500 hover:text-slate-200"}`}>
              <Icon className={`h-3.5 w-3.5 ${mode === id ? "text-rose-400" : ""}`} /><span className="sr-only sm:not-sr-only">{label}</span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          {mode === "chat" ? (
            <button onClick={() => (searching ? closeSearch() : setSearching(true))} aria-pressed={searching}
              className={`rounded-lg p-2 transition ${searching ? "bg-white/[0.08] text-white" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}
              aria-label="Search messages" title="Search (on this device)">
              <Search className="h-4 w-4" />
            </button>
          ) : null}
          <Members session={session} openModal={openModal} onError={onError} />
          <button onClick={async () => { try { await session.sync(); onChange(); } catch (e) { onError(e.message); } }}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-white/[0.06] hover:text-white" aria-label="Sync" title="Sync now">
            <RefreshCw className="h-4 w-4" />
          </button>
          <Button icon={UserPlus} variant="ghost" disabled={!joined}
            onClick={invite} className="ml-1 !px-2.5 !py-1.5 !text-xs sm:!px-3">
            <span className="sr-only sm:not-sr-only">Invite</span>
          </Button>
        </div>
      </div>

      {mode === "canvas" ? <Canvas session={session} onError={onError} openModal={openModal} /> : (
      <>
      {searching ? (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-white/[0.07] bg-ink-900/60 px-3 py-2 sm:px-5">
          <Search className="h-4 w-4 shrink-0 text-rose-400/80" />
          <input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
            onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
            placeholder="Search this channel (on this device)" aria-label="Search this channel"
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-slate-600 focus:outline-none" />
          {q ? (
            <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-slate-400" role="status">
              {source.length} match{source.length === 1 ? "" : "es"}
            </span>
          ) : null}
          <button onClick={closeSearch} aria-label="Close search"
            className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} role="log" aria-label="Messages"
        className="dp-scroll min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
        {!session.client && !session.removed ? (
          <Placeholder icon={Lock}>
            This device isn't a member yet. Once someone invites you, the Welcome arrives on the
            next poll and history starts from that point — earlier traffic stays unreadable, by design.
            If another of your devices is in this channel, invite your own handle from there.
          </Placeholder>
        ) : session.history.length === 0 ? (
          <Placeholder icon={MessageSquare} title="Nothing here yet.">
            Say something unwise. It's encrypted on this device before it leaves, for the members of
            #{session.channel.slug} and no one else.
          </Placeholder>
        ) : q && source.length === 0 ? (
          <Placeholder icon={Search}>No messages here match “{query.trim()}”.</Placeholder>
        ) : (
          <ul>
            {hidden ? (
              <li className="mb-4 text-center">
                <button onClick={() => setShown((n) => n + PAGE)}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1 text-xs text-slate-400 transition hover:bg-white/[0.06] hover:text-white">
                  Show {Math.min(PAGE, hidden)} earlier {q ? "match" : "message"}{Math.min(PAGE, hidden) === 1 ? "" : q ? "es" : "s"}
                </button>
              </li>
            ) : null}
            {visible.map((m, i) => {
              const prev = visible[i - 1];
              const newDay = dayOf(m) && dayOf(m) !== dayOf(prev || {});
              // Consecutive messages from one signing key, close in time, read as
              // one block; anything with a trust warning keeps its own sender line.
              const grouped = !newDay && groupsWith(prev, m);
              return (
              <React.Fragment key={`${m.seq}:${m.notice ? "n" : m.audit ? "a" : m.error ? "e" : "m"}:${hidden + i}`}>
              {newDay ? (
                <li role="separator" className="my-4 flex items-center gap-3 text-[11px] font-medium text-slate-500">
                  <span className="h-px flex-1 bg-gradient-to-r from-transparent to-white/10" />
                  <span className="rounded-full border border-white/[0.08] bg-ink-900 px-2.5 py-0.5">{dayLabel(m.at)}</span>
                  <span className="h-px flex-1 bg-gradient-to-l from-transparent to-white/10" />
                </li>
              ) : null}
              {/* seq alone isn't unique: notices reuse the seq of the message they follow. */}
              <li data-seq={m.text !== undefined || m.deleted ? m.seq : undefined}
                data-flash={flash && !m.notice && !m.audit && !m.error && flash.seq === m.seq ? "" : undefined}
                className={`${grouped ? "mt-0.5" : i === 0 ? "" : "mt-3"} animate-[dp-rise_0.25s_ease-out_both]`}>
                {m.audit ? (
                  <SystemLine tone="amber" icon={AlertTriangle}>
                    {m.from || "someone"}{m.claimed ? ` (claiming to be ${m.claimed})` : ""} removed {m.audit.removed.join(", ")} from the group
                  </SystemLine>
                ) : m.notice ? (
                  <SystemLine tone="cyan" icon={Info}>{m.notice}</SystemLine>
                ) : m.error ? (
                  <SystemLine tone="amber" icon={AlertTriangle}>Message {m.seq} couldn't be decrypted — {m.error}</SystemLine>
                ) : (
                  <div className={`dp-msg group flex items-end gap-2.5 ${m.mine ? "flex-row-reverse" : ""}`}>
                    {!m.mine ? (
                      grouped ? <span className="w-8 shrink-0" /> : <Avatar name={m.from || "?"} size={32} className="mb-0.5" />
                    ) : null}
                    <div className={`flex min-w-0 max-w-[min(36rem,85%)] flex-col ${m.mine ? "items-end" : "items-start"}`}>
                      {!m.mine && m.from && !grouped ? (
                        <p className="mb-1 ml-1 flex flex-wrap items-baseline gap-x-1.5 text-xs">
                          <span className="font-semibold text-slate-200"><Highlight text={m.from} q={q} /></span>
                          {m.unverified ? (
                            <span className="text-amber-400" title="No account has registered the key that signed this">unverified</span>
                          ) : null}
                          {m.claimed ? (
                            <span className="text-amber-400" title="The sender's credential names someone else">claims to be {m.claimed}</span>
                          ) : null}
                          {m.at ? <time className="text-[11px] text-slate-500" dateTime={m.at} title={new Date(m.at).toLocaleString()}>{fmtTime(m.at)}</time> : null}
                        </p>
                      ) : null}
                      {m.deleted ? (
                        <p className="rounded-2xl border border-dashed border-white/10 px-3.5 py-2 text-xs italic text-slate-500">
                          {m.mine ? "You deleted this message" : `${m.from || "Someone"} deleted this message`}
                        </p>
                      ) : (
                      <div className="relative">
                        <div title={`#${m.seq}`} data-mentions-me={!m.mine && mentionsIn(m.text).has(session.handle) ? "" : undefined}
                          className={`rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed shadow-sm
                          ${!m.mine && mentionsIn(m.text).has(session.handle) ? "ring-2 ring-amber-400/50" : ""}
                          ${m.mine
                            ? `bg-gradient-to-b from-rose-500 to-rose-600 text-white ${grouped ? "rounded-tr-md" : ""}`
                            : `border border-white/[0.07] bg-ink-800 text-slate-100 ${grouped ? "rounded-tl-md" : ""}`}`}>
                          {m.re !== undefined ? (() => {
                            const t = quoted(m.re);
                            const skin = `mb-1.5 block w-full rounded-lg border-l-2 px-2 py-1 text-left text-xs
                              ${m.mine ? "border-white/60 bg-black/15 text-rose-50/90" : "border-rose-400/60 bg-white/[0.04] text-slate-400"}`;
                            if (!t) return <p className={skin}>A message not on this device</p>;
                            return (
                              <button onClick={() => jumpTo(m.re)} title="Go to the message" aria-label={`Go to the quoted message${t.deleted ? "" : `: ${snippet(t.text)}`}`}
                                className={`${skin} transition ${m.mine ? "hover:bg-black/25" : "hover:bg-white/[0.08]"}`}>
                                {t.deleted ? "A deleted message"
                                  : <><span className="font-semibold">{t.mine ? "You" : t.from || "someone"}</span>: {snippet(t.text)}</>}
                              </button>
                            );
                          })() : null}
                          <div className="whitespace-pre-wrap break-words">
                            <RichText text={m.text} me={session.handle} leaf={(t) => <Highlight text={t} q={q} />} />
                          </div>
                        </div>
                        {joined ? (
                          <div data-pinned={confirmDelete === m.seq || picker === m.seq ? "" : undefined}
                            className={`dp-actions absolute -top-4 z-10 flex items-center gap-0.5 whitespace-nowrap rounded-lg border border-white/10
                              bg-ink-850 p-0.5 shadow-lift sm:top-1/2 sm:-translate-y-1/2
                              ${m.mine ? "left-0 sm:left-auto sm:right-full sm:mr-2" : "right-0 sm:right-auto sm:left-full sm:ml-2"}`}>
                            <span className="relative" data-picker="">
                              <button onClick={() => setPicker((p) => (p === m.seq ? null : m.seq))} aria-label="Add reaction"
                                aria-expanded={picker === m.seq} title="React"
                                className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-white">
                                <SmilePlus className="h-3.5 w-3.5" />
                              </button>
                              {picker === m.seq ? (
                                <span role="menu" aria-label="Reactions"
                                  className={`absolute bottom-full z-20 mb-2 flex gap-0.5 rounded-xl border border-white/10 bg-ink-850 p-1 shadow-lift
                                    animate-[dp-rise_0.12s_ease-out_both] ${m.mine ? "right-0" : "left-0"}`}>
                                  {REACTIONS.map((e) => {
                                    const on = !!(myKey && m.reactions?.[e]?.[myKey] !== undefined);
                                    return (
                                      <button key={e} role="menuitem" onClick={() => react(m.seq, e, !on)} aria-label={`React ${e}`}
                                        className={`rounded-lg px-1.5 py-1 text-lg leading-none transition hover:scale-110 hover:bg-white/10 ${on ? "bg-white/10" : ""}`}>
                                        {e}
                                      </button>
                                    );
                                  })}
                                </span>
                              ) : null}
                            </span>
                            <button onClick={() => startReply(m)} aria-label="Reply" title="Reply"
                              className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-white">
                              <Reply className="h-3.5 w-3.5" />
                            </button>
                            {m.mine ? (
                              <button onClick={() => startEdit(m)} aria-label="Edit message" title="Edit for everyone"
                                className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-white">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                            {m.mine ? (
                              <button onClick={() => remove(m.seq)} onBlur={() => setConfirmDelete(null)}
                                title="Delete for everyone. Members' clients replace it; a modified client could keep a copy."
                                aria-label={confirmDelete === m.seq ? "Confirm delete for everyone" : "Delete message"}
                                className={`flex items-center gap-1 rounded-md p-1.5 text-xs transition ${confirmDelete === m.seq
                                  ? "bg-rose-600 px-2 font-medium text-white" : "text-slate-400 hover:bg-rose-500/15 hover:text-rose-300"}`}>
                                <Trash2 className="h-3.5 w-3.5" />{confirmDelete === m.seq ? "Delete for everyone?" : null}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      )}
                      {m.reactions && !m.deleted ? (
                        <div className={`mt-1 flex flex-wrap gap-1 ${m.mine ? "justify-end" : ""}`}>
                          {REACTIONS.filter((e) => m.reactions[e]).map((e) => {
                            const who = m.reactions[e];
                            const on = !!(myKey && who[myKey] !== undefined);
                            const names = Object.values(who).map((h) => h || "someone");
                            return (
                              <button key={e} onClick={() => joined && react(m.seq, e, !on)} disabled={!joined}
                                aria-pressed={on} aria-label={`${e} ${names.length}`} title={names.join(", ")}
                                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition
                                  ${on ? "border-rose-400/50 bg-rose-500/15 text-rose-100" : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"}`}>
                                <span className="text-sm leading-none">{e}</span>{names.length}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      {(m.mine || grouped || m.edited) && !m.deleted ? (
                        <p className={`mt-0.5 flex items-center gap-1.5 px-1 text-[10px] text-slate-500 ${grouped && !m.edited && !m.mine ? "hidden" : ""}`}>
                          {m.mine && m.at ? <time dateTime={m.at} title={new Date(m.at).toLocaleString()}>{fmtTime(m.at)}</time> : null}
                          {m.edited ? <span title="Edited by its author">edited</span> : null}
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}
              </li>
              </React.Fragment>
              );
            })}
          </ul>
        )}
        </div>
        <div ref={endRef} />
      </div>
      {unseen > 0 ? (
        <button onClick={toEnd}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full
            bg-gradient-to-b from-rose-500 to-rose-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-glow
            animate-[dp-rise_0.2s_ease-out_both] hover:from-rose-400">
          <ArrowDown className="h-3.5 w-3.5" />{unseen} new message{unseen === 1 ? "" : "s"}
        </button>
      ) : null}
      </div>

      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-6 sm:pb-5">
        <div className="mx-auto w-full max-w-3xl">
        <p aria-live="polite" className="mb-1 flex h-4 items-center gap-1.5 truncate pl-1 text-[11px] text-slate-500">
          {typers.length ? <span className="inline-flex gap-0.5" aria-hidden="true">
            {[0, 1, 2].map((d) => <span key={d} className="h-1 w-1 rounded-full bg-rose-400" style={{ animation: `dp-pulse 1s ${d * 0.15}s infinite` }} />)}
          </span> : null}
          {typingLine(typers)}
        </p>
        {suggestions.length ? (
          <ul id="mention-list" role="listbox" aria-label="Mention someone"
            className="mb-2 w-64 overflow-hidden rounded-xl border border-white/10 bg-ink-850 p-1 shadow-lift animate-[dp-rise_0.12s_ease-out_both]">
            {suggestions.map((h, i) => (
              <li key={h} role="option" aria-selected={i === pick}
                onMouseDown={(e) => { e.preventDefault(); completeMention(h); }}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${i === pick ? "bg-white/[0.08] text-white" : "text-slate-300"}`}>
                <Avatar name={h} size={20} /><span className="font-mono text-xs">@{h}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className={`rounded-2xl border bg-ink-850 shadow-lift transition
          ${joined ? "border-white/10 focus-within:border-rose-500/50 focus-within:ring-4 focus-within:ring-rose-500/10" : "border-white/[0.06] opacity-60"}`}>
        {replyTo || editing ? (
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2 text-xs text-slate-400">
            {editing ? <Pencil className="h-3.5 w-3.5 shrink-0 text-rose-400" /> : <Reply className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
            <span className="min-w-0 flex-1 truncate">
              {editing ? "Editing your message" : <>Replying to <span className="font-semibold text-slate-200">{replyTo.mine ? "yourself" : replyTo.from || "someone"}</span>: {snippet(replyTo.text || "")}</>}
            </span>
            <button onClick={() => (editing ? stopEditing() : setReplyTo(null))}
              aria-label={editing ? "Cancel editing" : "Cancel reply"} className="rounded-md p-1 transition hover:bg-white/10 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="flex items-end gap-2 p-1.5 pl-3">
          <textarea
            ref={composer}
            rows={1}
            value={draft}
            disabled={!joined}
            onChange={(e) => {
              setDraft(e.target.value); setCaret(e.target.selectionStart); setMentionOff(false); setPick(0);
              presence.current?.typing(!!e.target.value.trim());
            }}
            onSelect={(e) => setCaret(e.target.selectionStart)}
            aria-autocomplete="list" aria-controls={suggestions.length ? "mention-list" : undefined}
            onKeyDown={(e) => {
              if (suggestions.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPick((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); completeMention(suggestions[pick] || suggestions[0]); return; }
                if (e.key === "Escape") { e.preventDefault(); setMentionOff(true); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              // Up in an empty composer edits your last message, as in most chat apps.
              if (e.key === "ArrowUp" && !draft && !editing && joined) {
                const last = session.history.findLast((h) => h.mine && h.text !== undefined && !h.deleted);
                if (last) { e.preventDefault(); startEdit(last); }
              }
              if (e.key === "Escape") { if (editing) stopEditing(); else setReplyTo(null); }
            }}
            placeholder={joined
              // The full line wraps (and clips) in a one-row box on a phone.
              ? (window.matchMedia?.("(max-width: 639px)").matches ? "Encrypted before it leaves…" : "Encrypted before it leaves this tab…")
              : session.removed ? "Removed from this channel" : "Not a member yet"}
            className="dp-scroll max-h-40 min-h-[40px] flex-1 resize-none bg-transparent py-2.5 text-[14px] leading-relaxed text-white
              outline-none placeholder:text-slate-600 disabled:cursor-not-allowed"
          />
          <Button icon={Send} busy={busy === "send"} disabled={!joined || !draft.trim()} onClick={send}
            className="!rounded-xl !px-3 sm:!px-4">
            <span className="sr-only sm:not-sr-only">{editing ? "Save" : "Send"}</span>
          </Button>
        </div>
        </div>
        <p className="mt-1.5 hidden items-center justify-center gap-1 text-[10px] text-slate-600 sm:flex">
          <Lock className="h-2.5 w-2.5" /> End-to-end encrypted with MLS · Enter to send, Shift+Enter for a new line, ↑ to edit your last
        </p>
        </div>
      </div>
      </>
      )}
    </>
  );
}
