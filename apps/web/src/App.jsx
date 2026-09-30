import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Check, Fingerprint, Hash, KeyRound, Loader2, LogOut, Plus,
  MessageSquare, PenLine, RefreshCw, Send, Shield, Skull, UserPlus, Users, X,
} from "lucide-react";
import Canvas from "./Canvas.jsx";
import { ChoiceModal, ConfirmModal, PromptModal } from "./Modal.jsx";
import { api } from "./lib/api.js";
import { store, K } from "./lib/db.js";
import { GroupSession, SUITE, ensureDevice, login, register } from "./lib/session.js";
import { Hints } from "./lib/hints.js";

const SYNC_MS = 2500;
// While the hint socket is up, the api tells us when to fetch; polling only
// covers a hint that got lost.
const FALLBACK_MS = 20_000;
// eslint-disable-next-line no-undef
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";  // set by vite.config.js

/* ------------------------------------------------------------ primitives */

/** "14:05" today, "Mar 3 14:05" otherwise. */
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function Glass({ className = "", children }) {
  const positioned = /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className);
  return (
    <div className={`${positioned ? "" : "relative "}rounded-xl border border-white/10 bg-white/[0.035] backdrop-blur-xl ${className}`}>
      {children}
    </div>
  );
}

function Button({ children, icon: Icon, busy, variant = "primary", className = "", ...rest }) {
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

function Banner({ kind = "error", children, onClose }) {
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

/* ------------------------------------------------------------- auth gate */

function AuthScreen({ onAuthed, bootError }) {
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
    <div className="flex min-h-full items-center justify-center p-6">
      <div aria-hidden className="pointer-events-none fixed inset-0">
        <div className="absolute -left-24 top-10 h-96 w-96 rounded-full bg-rose-600/15 blur-[130px]" />
        <div className="absolute -right-24 bottom-10 h-96 w-96 rounded-full bg-fuchsia-600/10 blur-[130px]" />
      </div>

      <Glass className="w-full max-w-md p-8">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-600/10">
            <Skull className="h-5 w-5 text-rose-400" strokeWidth={1.75} />
          </span>
          <span className="text-sm font-black tracking-[0.2em] text-white">
            DEADP0ET<span className="text-rose-500">.ARMY</span>
          </span>
        </div>

        <h1 className="mt-6 text-2xl font-black tracking-tight text-white">Console access</h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Passkey only. There is no password to steal, phish, or reuse.
        </p>

        <label htmlFor="handle" className="mt-6 block text-[11px] uppercase tracking-widest text-slate-500">
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
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2.5 font-mono text-sm text-white
            outline-none transition-colors placeholder:text-slate-600 focus:border-rose-500/60"
        />
        <p className="mt-1.5 text-[11px] text-slate-600">3–32 chars: a–z, 0–9, underscore.</p>

        {err ? <div className="mt-4"><Banner onClose={() => setErr(null)}>{err}</Banner></div> : null}

        <div className="mt-6 flex gap-2">
          <Button icon={Fingerprint} busy={busy === "login"} disabled={!valid || busy}
            onClick={() => run(login, "login")} className="flex-1">
            Sign in
          </Button>
          <Button icon={KeyRound} variant="ghost" busy={busy === "register"} disabled={!valid || busy}
            onClick={() => run(register, "register")} className="flex-1">
            Create passkey
          </Button>
        </div>

        <p className="mt-6 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-slate-600">
          Keys are generated on this device and never leave it. Clearing site data for this
          origin destroys your group history — we cannot restore it, which is rather the point.
        </p>
      </Glass>
    </div>
  );
}

/* -------------------------------------------------------------- main app */

function App() {
  const [phase, setPhase] = useState("boot");     // boot | auth | ready
  const [handle, setHandle] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [channels, setChannels] = useState([]);
  const [active, setActive] = useState(null);     // GroupSession
  const [tick, setTick] = useState(0);            // forces re-render on sync
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);
  const sessions = useRef(new Map());
  const notifiedWelcomes = useRef(new Set());
  const hints = useRef(null);
  const [unread, setUnread] = useState(() => new Set());   // groupIds with news we haven't opened
  const activeRef = useRef(null);
  activeRef.current = active;
  const [modal, setModal] = useState(null);

  const bump = useCallback(() => setTick((t) => t + 1), []);

  /* ----------------------------------------------------------- bootstrap */

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { user } = await api.me();
        if (dead) return;
        await boot(user.handle);
      } catch {
        if (!dead) setPhase("auth");
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function boot(h) {
    setHandle(h);
    const { deviceId: id } = await ensureDevice(h);
    setDeviceId(id);
    const { channels: list } = await api.channels();
    setChannels(list);
    setPhase("ready");
  }

  const onAuthed = async (h) => {
    setPhase("boot");
    setErr(null);
    try {
      await boot(h);
    } catch (e) {
      setErr(`Signed in, but device setup failed: ${e.message}`);
      setPhase("auth");
    }
  };

  /* ------------------------------------------------------------ channels */

  async function openChannel(ch) {
    setErr(null);
    if (ch.groupId) {
      setUnread((u) => { if (!u.has(ch.groupId)) return u; const n = new Set(u); n.delete(ch.groupId); return n; });
    }
    let s = sessions.current.get(ch.id);
    // A cached session without MLS state is one whose join (or founding)
    // didn't happen yet — typically opened before the Welcome arrived. Retry
    // rather than leaving the channel stuck until a reload.
    if (!s || !s.client) {
      if (!s) {
        s = new GroupSession(handle, deviceId, ch);
        sessions.current.set(ch.id, s);
      }
      try {
        if (!ch.groupId) {
          // Channel exists with no MLS group yet — we found it.
          await s.open(null);
          setChannels((list) => list.map((c) => (c.id === ch.id ? { ...c, groupId: s.groupId } : c)));
        } else {
          // Group exists. Restore local state, or accept a pending Welcome.
          const restored = await s.open(ch.groupId);
          if (!restored) {
            s.groupId = ch.groupId;
            const joined = await s.tryJoin();
            if (!joined) {
              setErr("This device has no key material for that channel yet. Ask a member to invite it — or invite your own handle from one of your devices that is in it.");
            }
          }
        }
      } catch (e) {
        setErr(e.message);
      }
    }
    setActive(s);
    bump();
  }

  async function createChannel(slug) {
    setBusy("create");
    setErr(null);
    try {
      const ch = await api.createChannel(slug.trim().toLowerCase(), "chat");
      const s = new GroupSession(handle, deviceId, ch);
      await s.open(null);                       // founds the MLS group
      sessions.current.set(ch.id, s);
      const withGroup = { ...ch, groupId: s.groupId };
      setChannels((c) => [withGroup, ...c]);
      setActive(s);
      setNotice(`#${ch.slug} created — you are its only member until you invite someone.`);
      bump();
    } catch (e) {
      throw e;               // surfaced inline by the modal
    } finally {
      setBusy(null);
    }
  }

  /* ---------------------------------------------------------- background */

  // One hint socket per signed-in tab.
  useEffect(() => {
    if (phase !== "ready") return undefined;
    const h = new Hints();
    h.connect();
    hints.current = h;
    // News for a channel that isn't on screen marks it unread.
    h.on((hint) => {
      if (hint.t !== "log" || hint.g === activeRef.current?.groupId) return;
      setUnread((u) => (u.has(hint.g) ? u : new Set(u).add(hint.g)));
    });
    return () => { h.close(); if (hints.current === h) hints.current = null; };
  }, [phase]);

  // Check for pending Welcomes — on a hint, or on a (slow, if hinted) poll —
  // so an invited device joins without a reload.
  useEffect(() => {
    if (phase !== "ready" || !deviceId) return;
    let dead = false;
    let last = 0;
    const check = async () => {
      last = Date.now();
      try {
        const { welcomes } = await api.welcomes(deviceId);
        if (dead || !welcomes.length) return;

        // A session already open on a group we've just been welcomed into
        // (the user was looking at it, waiting) joins straight away.
        const joined = new Set();
        for (const s of sessions.current.values()) {
          if (s.client || !s.groupId || !welcomes.some((w) => w.groupId === s.groupId)) continue;
          if (await s.tryJoin().catch(() => false)) joined.add(s.groupId);
        }
        if (dead) return;
        if (joined.size) { setErr(null); bump(); }

        // Announce each Welcome once, not on every poll until it's accepted —
        // and not at all for the ones just joined above.
        const fresh = welcomes.filter((w) => !notifiedWelcomes.current.has(w.id));
        if (!fresh.length) return;
        fresh.forEach((w) => notifiedWelcomes.current.add(w.id));
        const { channels: list } = await api.channels();
        if (dead) return;
        setChannels(list);
        const pending = fresh.filter((w) => !joined.has(w.groupId)).length;
        if (pending) {
          setNotice(`Invited to ${pending} group${pending > 1 ? "s" : ""} — open it to join.`);
        }
      } catch { /* transient */ }
    };
    const id = setInterval(() => {
      if (hints.current?.connected && Date.now() - last < FALLBACK_MS) return;
      check();
    }, SYNC_MS * 2);
    const off = hints.current?.on((h) => { if (h.t === "welcome") check(); });
    return () => { dead = true; clearInterval(id); off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, deviceId]);

  // Drain the active group's log.
  useEffect(() => {
    if (!active || !active.client) return;
    let dead = false;
    let last = 0;
    const pull = async () => {
      last = Date.now();
      try {
        const { applied, removed } = await active.sync();
        if (dead) return;
        if (removed) {
          // Access is gone server-side; polling again would only 404.
          clearInterval(id);
          const { channels: list } = await api.channels().catch(() => ({ channels: null }));
          if (!dead && list) setChannels(list);
          bump();
          return;
        }
        if (applied) bump();
      } catch (e) {
        if (!dead) setErr(e.message);
      }
    };
    pull();
    const id = setInterval(() => {
      if (hints.current?.connected && Date.now() - last < FALLBACK_MS) return;
      pull();
    }, SYNC_MS);
    const off = hints.current?.on((h) => { if (h.t === "log" && h.g === active.groupId) pull(); });
    return () => { dead = true; clearInterval(id); off?.(); };
    // `active.client` is in the deps so a session that joins while selected
    // (Welcome arrived after it was opened) starts syncing without a reselect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, active?.client]);

  /* --------------------------------------------------------------- views */

  if (phase === "boot") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin text-rose-500" />
          <span className="font-mono text-xs uppercase tracking-widest">initialising key material…</span>
        </div>
      </div>
    );
  }

  if (phase === "auth") return <AuthScreen onAuthed={onAuthed} bootError={err} />;

  return (
    <div className="flex h-full min-h-full flex-col bg-[#05060a] text-slate-200">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <Skull className="h-5 w-5 text-rose-500" strokeWidth={1.75} />
        <span className="text-xs font-black tracking-[0.2em] text-white">
          DEADP0ET<span className="text-rose-500">.ARMY</span>
        </span>
        <span className="ml-2 hidden rounded border border-white/10 px-2 py-0.5 font-mono text-[10px] text-slate-500 sm:inline">
          {SUITE}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden font-mono text-[10px] text-slate-600 sm:inline">build {BUILD}</span>
          <span className="font-mono text-[11px] text-slate-500">@{handle}</span>
          <button
            onClick={() => setModal({ kind: "signout" })}
            className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:text-white"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* channels */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-white/10">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">Channels</span>
            <button onClick={() => setModal({ kind: "channel" })} disabled={busy === "create"}
              className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-40"
              aria-label="New channel">
              {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </button>
          </div>
          <div className="dp-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {channels.length === 0 ? (
              <p className="px-2 py-4 text-[11px] leading-relaxed text-slate-600">
                No channels yet. Create one — it becomes an MLS group whose keys never reach the server.
              </p>
            ) : channels.map((ch) => (
              <button key={ch.id} onClick={() => openChannel(ch)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors
                  ${active?.channel?.id === ch.id ? "bg-rose-600/15 text-white" : "text-slate-400 hover:bg-white/5"}`}>
                <Hash className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span className={`truncate ${unread.has(ch.groupId) ? "font-semibold text-white" : ""}`}>{ch.slug}</span>
                {unread.has(ch.groupId) ? (
                  <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-label="unread" />
                ) : null}
              </button>
            ))}
          </div>
        </aside>

        {/* conversation */}
        <main className="flex min-w-0 flex-1 flex-col">
          {(err || notice) ? (
            <div className="space-y-2 px-4 pt-3">
              {err ? <Banner onClose={() => setErr(null)}>{err}</Banner> : null}
              {notice ? <Banner kind="info" onClose={() => setNotice(null)}>{notice}</Banner> : null}
            </div>
          ) : null}
          {active ? (
            <Conversation session={active} onError={setErr} onChange={bump} openModal={setModal} />
          ) : <EmptyState />}
        </main>
      </div>

      {modal?.kind === "channel" ? (
        <PromptModal
          title="New channel"
          label="Slug"
          placeholder="war-room"
          hint="2–48 chars: a–z, 0–9, dashes. Creates an MLS group whose keys never reach the server."
          submitLabel="Create"
          validate={(v) => (v && !/^[a-z0-9-]{2,48}$/.test(v) ? "Only a-z, 0-9 and dashes." : null)}
          onSubmit={createChannel}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.kind === "invite" ? (
        <PromptModal
          title={`Invite to #${modal.session.channel.slug}`}
          label="Handle"
          placeholder="ghost_01"
          hint="They must have signed in at least once, so a key package exists to claim. Only devices not already in the channel are added — invite your own handle to bring in a new device of yours."
          submitLabel="Invite"
          validate={(v) => (v && !/^[a-z0-9_]{3,32}$/.test(v) ? "Only a-z, 0-9 and underscore." : null)}
          onSubmit={async (h) => {
            const n = await modal.session.invite(h);
            bump();
            setNotice(`Invited ${h} (${n} device${n > 1 ? "s" : ""}). They join on their next poll.`);
          }}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.kind === "remove" ? (
        <ConfirmModal
          title={`Remove ${modal.handle}`}
          body={`${modal.handle} loses access to #${modal.session.channel.slug} and cannot read anything sent from now on. What they already received stays on their devices.`}
          confirmLabel="Remove"
          danger
          onConfirm={async () => {
            try {
              await modal.session.remove(modal.handle);
              bump();
              setNotice(`Removed ${modal.handle} from #${modal.session.channel.slug}.`);
            } catch (e) {
              setErr(e.message);
              throw e;
            }
          }}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.kind === "leave" ? (
        <ConfirmModal
          title={`Leave #${modal.session.channel.slug}`}
          body="You lose access immediately, and this device forgets the channel's keys and history. Only an invite can bring you back."
          confirmLabel="Leave"
          danger
          onConfirm={async () => {
            const s = modal.session;
            try {
              await s.leave();
            } catch (e) {
              setErr(e.message);
              throw e;
            }
            sessions.current.delete(s.channel.id);
            setChannels((list) => list.filter((c) => c.id !== s.channel.id));
            setActive((a) => (a === s ? null : a));
            setNotice(`Left #${s.channel.slug}.`);
          }}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.kind === "signout" ? (
        // This device keeps its keys either way: signing back in picks up
        // where it left off.
        <ChoiceModal
          title="Sign out"
          body={'This device keeps its keys either way. "Everywhere" also ends every other session on your account — use it if a device is lost.'}
          choices={[
            { label: "Sign out", primary: true, onPick: async () => { await api.logout(); location.reload(); } },
            { label: "Sign out everywhere", onPick: async () => { await api.logoutAll(); location.reload(); } },
          ]}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.kind === "clear" ? (
        <ConfirmModal
          title="Clear the board"
          body="This removes every stroke for everyone in the group. It cannot be undone."
          confirmLabel="Clear it"
          danger
          onConfirm={modal.onConfirm}
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}

function EmptyState() {
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
function Members({ session, openModal }) {
  const [members, setMembers] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (session.removed) return undefined;    // the roster is no longer ours to read
    let dead = false;
    api.members(session.channel.id)
      .then((r) => { if (!dead) setMembers(r.members); })
      .catch(() => { if (!dead) setMembers(null); });
    return () => { dead = true; };
  }, [session.channel.id, session.epoch, session.removed]);

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
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Members"
        className="flex items-center gap-1 rounded px-1.5 py-1 font-mono text-[11px] text-slate-400 hover:bg-white/5 hover:text-white">
        <Users className="h-3.5 w-3.5" />{members.length}
      </button>
      {open ? (
        <ul className="absolute right-0 top-full z-20 mt-1 max-h-72 min-w-[12rem] overflow-y-auto rounded-lg border
          border-white/10 bg-[#0b0d14] p-1 shadow-2xl">
          {members.map((m) => (
            <li key={m.handle} className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-xs">
              <span className="font-mono text-slate-200">{m.handle}</span>
              {m.role !== "member" ? (
                <span className="text-[10px] uppercase tracking-wider text-rose-400/80">{m.role}</span>
              ) : canRemove(m) ? (
                <button onClick={() => { setOpen(false); openModal({ kind: "remove", session, handle: m.handle }); }}
                  className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-500
                    hover:bg-rose-600/20 hover:text-rose-300">
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

function Conversation({ session, onError, onChange, openModal }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(null);
  const [mode, setMode] = useState(session.channel.kind === "canvas" ? "canvas" : "chat");
  const endRef = useRef(null);

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
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <Hash className="h-4 w-4 text-slate-600" />
        <span className="text-sm font-semibold text-white">{session.channel.slug}</span>
        <span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
          epoch {session.epoch ?? "—"}
        </span>

        <div className="ml-4 flex rounded-lg border border-white/10 bg-white/5 p-0.5">
          {[["chat", "Chat", MessageSquare], ["canvas", "Canvas", PenLine]].map(([id, label, Icon]) => (
            <button key={id} onClick={() => setMode(id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors
                ${mode === id ? "bg-rose-600 text-white" : "text-slate-400 hover:text-white"}`}>
              <Icon className="h-3 w-3" />{label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Members session={session} openModal={openModal} />
          <button onClick={async () => { try { await session.sync(); onChange(); } catch (e) { onError(e.message); } }}
            className="rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-white" aria-label="Sync">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <Button icon={UserPlus} variant="ghost" disabled={!joined}
            onClick={invite} className="!px-3 !py-1.5 !text-xs">
            Invite
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
            {session.history.map((m) => (
              <li key={m.seq} className="animate-[dp-rise_0.25s_ease-out_both]">
                {m.notice ? (
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
                        <p className="mb-0.5 font-mono text-[10px] font-semibold text-cyan-300/80">{m.from}</p>
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
            placeholder={joined ? "Encrypted before it leaves this tab…" : session.removed ? "Removed from this channel" : "Not a member yet"}
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

export default App;
