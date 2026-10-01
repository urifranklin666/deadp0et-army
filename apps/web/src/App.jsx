import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Fingerprint, Hash, Laptop, Loader2, Lock, LogOut, Plus, ShieldCheck, Skull, Trash2, Users } from "lucide-react";
import AuthScreen from "./AuthScreen.jsx";
import PasskeysModal from "./Passkeys.jsx";
import SessionsModal from "./Sessions.jsx";
import Conversation, { EmptyState } from "./Conversation.jsx";
import { ChoiceModal, ConfirmModal, PromptModal } from "./Modal.jsx";
import { Avatar, Banner } from "./ui.jsx";
import { api } from "./lib/api.js";
import { belongsTo, store } from "./lib/db.js";
import { withReauth } from "./lib/passkeys.js";
import { Hints } from "./lib/hints.js";
import { claimTab } from "./lib/tablock.js";
import { notify, notificationsOn, setNotifications } from "./lib/notifications.js";

const SYNC_MS = 2500;
// While the hint socket is up, the api tells us when to fetch; polling only
// covers a hint that got lost.
const FALLBACK_MS = 20_000;
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";  // set by vite.config.js

// The MLS stack is most of the bundle and nothing before sign-in needs it:
// start fetching it now, in parallel, and let the passkey screen paint first.
// A failed fetch is retried the next time it's needed.
let sessionModule = null;
const loadSession = () => (sessionModule ??= import("./lib/session.js").catch((e) => { sessionModule = null; throw e; }));
loadSession().catch(() => {});

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
  const channelsRef = useRef([]);
  channelsRef.current = channels;
  const [notifyOn, setNotifyOn] = useState(() => notificationsOn());
  const [modal, setModal] = useState(null);
  const mls = useRef(null);                       // lib/session.js, once loaded

  const bump = useCallback(() => setTick((t) => t + 1), []);

  // Confirmations ("Invited …") fade on their own; errors stay until dismissed.
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

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
    // Before touching any key material: another tab may already be using it.
    if (!(await claimTab(h))) { setPhase("elsewhere"); return; }
    mls.current = await loadSession();
    const { deviceId: id } = await mls.current.ensureDevice(h);
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
        s = new mls.current.GroupSession(handle, deviceId, ch);
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
      const s = new mls.current.GroupSession(handle, deviceId, ch);
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
      // Not decrypted yet (it isn't the open channel), so all we can say is where.
      const ch = channelsRef.current.find((c) => c.groupId === hint.g);
      if (ch) notify(`ch:${ch.id}`, "DEADP0ET.ARMY", `New activity in #${ch.slug}`);
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
        // Evicted devices whose report to the server didn't get through.
        for (const s of sessions.current.values()) {
          if (s.removed && s.groupId) s.retryEvictionReport().catch(() => {});
        }
        const { welcomes } = await api.welcomes(deviceId);
        if (dead || !welcomes.length) return;

        // A Welcome for a group this device already holds state for was
        // joined, but its ack never landed (the save happens first, then the
        // ack). Ack it now, or it lingers forever.
        // Only Welcomes at or before the session's cursor: a newer one may be
        // re-adding a device that hasn't yet seen the commit removing it.
        const done = welcomes.filter((w) =>
          [...sessions.current.values()].some((s) => s.client && s.groupId === w.groupId
            && w.joinedAtSeq != null && w.joinedAtSeq <= s.cursor));
        if (done.length) {
          await api.ackWelcomes(deviceId, done.map((w) => w.id)).catch(() => {});
          done.forEach((w) => notifiedWelcomes.current.add(w.id));
        }

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
    // Coalesce: a burst of hints (someone drawing flushes ~4/s) becomes one
    // fetch in flight plus at most one more, not a queued GET per hint.
    let inFlight = false;
    let again = false;
    const pull = async () => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      last = Date.now();
      try {
        const before = active.cursor;
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
        if (applied) {
          bump();
          // New messages from others, while the tab is in the background:
          // who and where, never what.
          // What this sync added (not every applied entry is a message: canvas
          // ops and deletions add none, so "the last N" would misreport).
          const fresh = active.history.filter((m) => m.seq > before && m.text !== undefined && !m.mine);
          const last = fresh[fresh.length - 1];
          if (last) {
            notify(`ch:${active.channel.id}`, `#${active.channel.slug}`,
              `${fresh.length > 1 ? `${fresh.length} new messages` : "New message"} from ${last.unverified ? "an unverified member" : last.from || "someone"}`);
          }
        }
      } catch (e) {
        if (!dead) setErr(e.message);
      } finally {
        inFlight = false;
        if (again && !dead) { again = false; pull(); }
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

  if (phase === "elsewhere") {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <Skull className="mx-auto h-8 w-8 text-rose-500" strokeWidth={1.75} />
          <h1 className="mt-4 text-lg font-bold text-white">Open in another tab</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            @{handle}'s keys are in use in another tab of this browser. Two tabs would advance the
            same encryption state separately and corrupt it, so only one may hold them. Close the
            other tab, then reload this one.
          </p>
          <button onClick={() => location.reload()}
            className="mt-5 rounded-lg border border-white/15 px-4 py-2 text-sm text-slate-200 hover:border-rose-500/50">
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dp-grid flex h-full min-h-full flex-col bg-ink-950 font-sans text-slate-200">
      <header className="relative z-10 flex shrink-0 items-center gap-3 border-b border-white/[0.07] bg-ink-950/80 px-3 py-2 backdrop-blur sm:px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-rose-500/30 bg-rose-500/10">
          <Skull className="h-4 w-4 text-rose-400" strokeWidth={1.75} />
        </span>
        <span className="text-[13px] font-extrabold tracking-[0.18em] text-white">
          DEADP0ET<span className="text-rose-500">.ARMY</span>
        </span>
        <span title={mls.current?.SUITE ? `MLS cipher suite: ${mls.current.SUITE}` : undefined}
          className="ml-1 hidden items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/[0.06] px-2.5 py-0.5
            text-[11px] font-medium text-emerald-300 sm:inline-flex">
          <Lock className="h-3 w-3" />End-to-end encrypted · post-quantum
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setModal({ kind: "signout" })}
            className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-1 pr-1 text-slate-300
              transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white sm:pr-3"
            aria-label="Account"
          >
            <Avatar name={handle} size={26} />
            <span className="hidden max-w-[10rem] truncate font-mono text-xs sm:inline">{handle}</span>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* channels */}
        {/* Phones show the list OR the open channel; md+ shows both. */}
        <aside className={`${active ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-white/[0.07] bg-ink-900/60 md:w-64 md:border-r`}>
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Channels</span>
            <button onClick={() => setModal({ kind: "channel" })} disabled={busy === "create"}
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
              aria-label="New channel" title="New channel">
              {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </button>
          </div>
          <nav className="dp-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {channels.length === 0 ? (
              <div className="mx-2 mt-2 rounded-xl border border-dashed border-white/10 p-4 text-center">
                <Hash className="mx-auto h-5 w-5 text-slate-600" />
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  No channels yet. Each one becomes an MLS group whose keys never reach the server.
                </p>
                <button onClick={() => setModal({ kind: "channel" })}
                  className="mt-3 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10">
                  Create a channel
                </button>
              </div>
            ) : channels.map((ch) => {
              const on = active?.channel?.id === ch.id;
              const news = unread.has(ch.groupId);
              return (
                <button key={ch.id} onClick={() => openChannel(ch)} aria-current={on ? "page" : undefined}
                  className={`group relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors
                    ${on ? "bg-white/[0.07] text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"}`}>
                  {on ? <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-rose-500" /> : null}
                  <Hash className={`h-4 w-4 shrink-0 ${on ? "text-rose-400" : "text-slate-600 group-hover:text-slate-500"}`} />
                  <span className={`truncate ${news ? "font-semibold text-white" : ""}`}>{ch.slug}</span>
                  {news ? (
                    <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,.8)]" aria-label="unread" />
                  ) : null}
                </button>
              );
            })}
          </nav>
          <div className="hidden border-t border-white/[0.06] px-4 py-3 md:block">
            <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400/80" /> Keys live on this device only
            </p>
          </div>
        </aside>

        {/* conversation */}
        <main className={`${active ? "flex" : "hidden md:flex"} relative min-w-0 flex-1 flex-col`}>
          {(err || notice) ? (
            // Floats over the conversation rather than pushing it down.
            <div className="pointer-events-none absolute inset-x-3 bottom-28 z-20 space-y-2 sm:inset-x-auto sm:bottom-auto sm:right-5 sm:top-16 sm:w-96">
              {err ? <div className="pointer-events-auto"><Banner onClose={() => setErr(null)}>{err}</Banner></div> : null}
              {notice ? <div className="pointer-events-auto"><Banner kind="ok" onClose={() => setNotice(null)}>{notice}</Banner></div> : null}
            </div>
          ) : null}
          {active ? (
            <Conversation key={active.channel.id} session={active} onError={setErr} onChange={bump} openModal={setModal}
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
          title="Account"
          header={(
            <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
              <Avatar name={handle} size={36} />
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-white">@{handle}</p>
                <p className="truncate font-mono text-[10px] text-slate-500" title={mls.current?.SUITE}>build {BUILD}</p>
              </div>
            </div>
          )}
          body={'Signing out keeps this device\'s keys either way. "Everywhere" also ends every other session on your account — use it if a device is lost.'}
          choices={[
            { label: "Passkeys…", icon: Fingerprint, hint: "Add a backup, remove one", onPick: () => { setModal({ kind: "passkeys" }); return false; } },
            { label: "Sessions…", icon: Laptop, hint: "Every signed-in browser", onPick: () => { setModal({ kind: "sessions" }); return false; } },
            {
              label: notifyOn ? "Turn off desktop notifications" : "Turn on desktop notifications",
              icon: notifyOn ? BellOff : Bell, hint: "Who and where — never what",
              onPick: async () => { setNotifyOn(await setNotifications(!notifyOn)); },
            },
            { label: "Sign out", icon: LogOut, primary: true, divider: true, onPick: async () => { await api.logout(); location.reload(); } },
            { label: "Sign out everywhere", icon: Users, hint: "Ends every session on your account", onPick: async () => { await api.logoutAll(); location.reload(); } },
            { label: "Delete account…", icon: Trash2, danger: true, divider: true, onPick: () => { setModal({ kind: "delete" }); return false; } },
          ]}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.kind === "passkeys" ? <PasskeysModal onClose={() => setModal(null)} /> : null}
      {modal?.kind === "sessions" ? <SessionsModal onClose={() => setModal(null)} /> : null}

      {modal?.kind === "delete" ? (
        <PromptModal
          title="Delete account"
          label={`Type ${handle} to confirm`}
          placeholder={handle}
          hint="Your passkey stops working here, this browser forgets every key, and the handle is retired for good. Channels you own pass to an admin or the longest-standing member; ones with nobody else in them are deleted."
          submitLabel="Delete for good"
          validate={(v) => (v && v !== handle ? `Type ${handle} exactly.` : null)}
          onSubmit={async (v) => {
            if (v !== handle) throw new Error(`Type ${handle} to confirm.`);
            await withReauth(() => api.deleteAccount());
            await store.deleteWhere(belongsTo(handle));
            location.reload();
          }}
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
