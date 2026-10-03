import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Fingerprint, Hash, Laptop, Loader2, LogOut, Plus, Search, ShieldCheck, Skull, Trash2, Users } from "lucide-react";
import AuthScreen from "./AuthScreen.jsx";
import PasskeysModal from "./Passkeys.jsx";
import SessionsModal from "./Sessions.jsx";
import Conversation, { EmptyState } from "./Conversation.jsx";
import { ChoiceModal, ConfirmModal, PromptModal, SwitcherModal } from "./Modal.jsx";
import { Avatar, Banner, Button } from "./ui.jsx";
import { api } from "./lib/api.js";
import { belongsTo, store } from "./lib/db.js";
import { withReauth } from "./lib/passkeys.js";
import { Hints } from "./lib/hints.js";
import { claimTab } from "./lib/tablock.js";
import { notify, notificationsOn, setNotifications } from "./lib/notifications.js";
import { mentionsIn } from "./lib/format.jsx";

const SYNC_MS = 2500;
// While the hint socket is up, the api tells us when to fetch; polling only
// covers a hint that got lost.
const FALLBACK_MS = 20_000;
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";  // set by vite.config.js
// What boot() does, in order; the boot screen ticks through them.
const BOOT_STEPS = ["passkey", "this tab", "mls stack", "device keys", "channels"];

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
  const [bootStep, setBootStep] = useState(0);   // which BOOT_STEPS line we are on
  const mls = useRef(null);                       // lib/session.js, once loaded

  const bump = useCallback(() => setTick((t) => t + 1), []);

  // Confirmations ("Invited …") fade on their own; errors stay until dismissed.
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  // Ctrl/⌘+K jumps to a channel from anywhere, unless a dialog is up.
  useEffect(() => {
    if (phase !== "ready") return undefined;
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setModal((m) => (m ? m : { kind: "switch" }));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase]);

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
    setBootStep(1);
    // Before touching any key material: another tab may already be using it.
    if (!(await claimTab(h))) { setPhase("elsewhere"); return; }
    setBootStep(2);
    mls.current = await loadSession();
    setBootStep(3);
    const { deviceId: id } = await mls.current.ensureDevice(h);
    setDeviceId(id);
    setBootStep(4);
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
          const mention = fresh.find((m) => mentionsIn(m.text).has(handle));
          if (mention) {
            // Still who and where, never what: the name is the signer's.
            notify(`ch:${active.channel.id}`, `#${active.channel.slug}`,
              `${mention.unverified ? "An unverified member" : mention.from || "Someone"} mentioned you`);
          } else if (last) {
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
      <div className="dp-noise flex min-h-full items-center justify-center bg-ink-950 p-6">
        <div className="w-full max-w-[17rem] font-mono" role="status" aria-live="polite">
          <p className="dp-eyebrow flex items-center gap-2 text-blood">
            <span className="h-2 w-2 bg-blood animate-[dp-blink_1s_steps(1)_infinite]" aria-hidden="true" />Booting
          </p>
          <ol className="mt-4 space-y-1.5 text-[12px]">
            {BOOT_STEPS.map((step, i) => (
              <li key={step} className={`flex items-center gap-3 ${i < bootStep ? "text-paper" : i === bootStep ? "text-acid" : "text-dim/50"}`}>
                <span className="w-4 text-center" aria-hidden="true">{i < bootStep ? "■" : i === bootStep ? "▶" : "□"}</span>
                <span className="uppercase tracking-label">{step}</span>
              </li>
            ))}
          </ol>
          <div className="mt-5 h-0.5 w-full bg-paper/10" aria-hidden="true">
            <div className="h-full bg-acid transition-[width] duration-300" style={{ width: `${(bootStep / BOOT_STEPS.length) * 100}%` }} />
          </div>
        </div>
      </div>
    );
  }

  if (phase === "auth") return <AuthScreen onAuthed={onAuthed} bootError={err} />;

  if (phase === "elsewhere") {
    return (
      <div className="dp-noise flex min-h-full items-center justify-center bg-ink-950 p-6">
        <div className="max-w-sm">
          <span className="dp-mark h-9 w-9"><Skull className="h-5 w-5" strokeWidth={2} /></span>
          <h1 className="mt-5 font-display text-[26px] leading-none tracking-[-0.03em] text-paper">Open in another tab</h1>
          <p className="mt-3 text-sm leading-relaxed text-paper-dim">
            @{handle}'s keys are in use in another tab of this browser. Two tabs would advance the
            same encryption state separately and corrupt it, so only one may hold them. Close the
            other tab, then reload this one.
          </p>
          <Button variant="ghost" onClick={() => location.reload()} className="mt-6">Reload</Button>
        </div>
      </div>
    );
  }

  const suite = mls.current?.SUITE;
  return (
    <div className="dp-noise flex h-full min-h-full flex-col bg-ink-950 font-sans text-paper">
      {/* The paper window bar: the console is the window the site's hero shows. */}
      <header className="relative z-10 flex h-11 shrink-0 items-center gap-3 bg-paper px-3 text-ink-950 sm:px-4">
        <span className="dp-mark h-7 w-7"><Skull className="h-4 w-4" strokeWidth={2} /></span>
        <span className="font-display text-[13px] tracking-[-0.03em]">DEADP0ET.ARMY</span>
        <span title={suite ? `MLS cipher suite: ${suite}` : undefined}
          className="dp-tag ml-2 hidden items-center gap-2 text-ink-950/60 md:inline-flex">
          <span className="h-1.5 w-1.5 bg-ink-950/60" aria-hidden="true" />E2EE · post-quantum · server: blind
        </span>
        <div className="ml-auto flex items-center">
          <button
            onClick={() => setModal({ kind: "signout" })}
            className="flex h-8 items-center gap-2 border-2 border-ink-950 bg-ink-950 text-paper transition-colors hover:bg-ink-800 sm:pr-3"
            aria-label="Account"
          >
            <Avatar name={handle} size={28} />
            <span className="hidden max-w-[10rem] truncate font-mono text-xs sm:inline">@{handle}</span>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* channels */}
        {/* Phones show the list OR the open channel; md+ shows both. */}
        <aside className={`${active ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-paper/15 md:w-64 md:border-r`}>
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <span className="dp-eyebrow text-dim">Channels</span>
            <button onClick={() => setModal({ kind: "switch" })} disabled={!channels.length}
              className="ml-auto mr-0.5 p-1.5 text-dim transition-colors hover:bg-paper/10 hover:text-paper disabled:opacity-40"
              aria-label="Jump to a channel" title={`Jump to a channel (${/Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘" : "Ctrl+"}K)`}>
              <Search className="h-4 w-4" />
            </button>
            <button onClick={() => setModal({ kind: "channel" })} disabled={busy === "create"}
              className="p-1.5 text-dim transition-colors hover:bg-paper/10 hover:text-paper disabled:opacity-40"
              aria-label="New channel" title="New channel">
              {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </button>
          </div>
          <nav className="dp-scroll min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
            {channels.length === 0 ? (
              <div className="mx-2 mt-2 border border-dashed border-paper/25 p-4 text-center">
                <Hash className="mx-auto h-5 w-5 text-dim" />
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-dim">
                  No channels yet. Each one becomes an MLS group whose keys never reach the server.
                </p>
                <button onClick={() => setModal({ kind: "channel" })}
                  className="mt-3 border border-paper/30 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-label text-paper transition-colors hover:border-paper hover:bg-paper/5">
                  Create a channel
                </button>
              </div>
            ) : channels.map((ch) => {
              const on = active?.channel?.id === ch.id;
              const news = unread.has(ch.groupId);
              return (
                <button key={ch.id} onClick={() => openChannel(ch)} aria-current={on ? "page" : undefined}
                  className={`group relative flex w-full items-center gap-2 px-2.5 py-2 text-left font-mono text-[13px] transition-colors
                    ${on ? "bg-paper/[0.07] text-paper" : "text-dim hover:bg-paper/[0.04] hover:text-paper"}`}>
                  {on ? <span className="absolute inset-y-0 left-0 w-[3px] bg-paper" /> : null}
                  <span className={`w-3 shrink-0 text-center ${on ? "text-blood" : "text-dim/60 group-hover:text-dim"}`} aria-hidden="true">#</span>
                  <span className={`truncate ${news ? "font-semibold text-paper" : ""}`}>{ch.slug}</span>
                  {news ? (
                    <span className="ml-auto h-2 w-2 shrink-0 bg-blood" aria-label="unread" />
                  ) : null}
                </button>
              );
            })}
          </nav>
          <div className="hidden border-t border-paper/15 px-4 py-3 md:block">
            <p className="dp-tag flex items-center gap-1.5 text-dim">
              <ShieldCheck className="h-3.5 w-3.5 text-acid" /> Keys: this device only
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
            <div className="mt-4 flex items-center gap-3 border border-paper/20 bg-ink-950 p-3">
              <Avatar name={handle} size={36} />
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-paper">@{handle}</p>
                <p className="dp-tag truncate text-dim" title={mls.current?.SUITE}>build {BUILD}</p>
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

      {modal?.kind === "switch" ? (
        <SwitcherModal channels={channels} unread={unread} activeId={active?.channel?.id}
          onPick={openChannel} onClose={() => setModal(null)} />
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
