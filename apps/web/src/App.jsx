import React, { useCallback, useEffect, useRef, useState } from "react";
import { Hash, Loader2, LogOut, Plus, Skull } from "lucide-react";
import AuthScreen from "./AuthScreen.jsx";
import Conversation, { EmptyState } from "./Conversation.jsx";
import { ChoiceModal, ConfirmModal, PromptModal } from "./Modal.jsx";
import { Banner } from "./ui.jsx";
import { api } from "./lib/api.js";
import { GroupSession, SUITE, ensureDevice } from "./lib/session.js";
import { Hints } from "./lib/hints.js";

const SYNC_MS = 2500;
// While the hint socket is up, the api tells us when to fetch; polling only
// covers a hint that got lost.
const FALLBACK_MS = 20_000;
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";  // set by vite.config.js

/* -------------------------------------------------------------- main app */

function App() {
  const [phase, setPhase] = useState("boot");     // boot | auth | ready
  const [handle, setHandle] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [channels, setChannels] = useState([]);
  const [active, setActive] = useState(null);     // GroupSession
  const [, setTick] = useState(0);            // forces re-render on sync
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
    } finally {                // errors surface inline in the modal
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
        {/* Phones show the list OR the open channel; md+ shows both. */}
        <aside className={`${active ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-white/10 md:w-56 md:border-r`}>
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
        <main className={`${active ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
          {(err || notice) ? (
            <div className="space-y-2 px-4 pt-3">
              {err ? <Banner onClose={() => setErr(null)}>{err}</Banner> : null}
              {notice ? <Banner kind="info" onClose={() => setNotice(null)}>{notice}</Banner> : null}
            </div>
          ) : null}
          {active ? (
            <Conversation session={active} onError={setErr} onChange={bump} openModal={setModal}
              onBack={() => setActive(null)} />
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

export default App;
