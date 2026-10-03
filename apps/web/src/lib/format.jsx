import React from "react";

/**
 * Light formatting for chat text, rendered as React elements, never as HTML:
 * whatever a member sends, nothing here can inject markup or script.
 *
 *   ```block```   **bold**   *italic* / _italic_   `code`   @handle   https://…
 *
 * `leaf(text, key)` renders plain runs (the transcript passes its search
 * highlighter). `me` is our handle, so mentions of us can stand out.
 */

// One alternative per token, tried left to right at each position.
const INLINE = new RegExp([
  "(`[^`\\n]+`)",                                   // 1 code
  "(\\*\\*[^*\\n]+\\*\\*)",                         // 2 bold
  "((?<![\\w*])\\*[^*\\s][^*\\n]*?\\*(?![\\w*]))",  // 3 *italic*
  "((?<!\\w)_[^_\\s][^_\\n]*?_(?!\\w))",            // 4 _italic_
  "(https?:\\/\\/[^\\s<>\"'`]+)",                   // 5 link
  "((?<![\\w@])@[a-z0-9_]{3,32}(?!\\w))",           // 6 mention
].join("|"), "gi");

/** Every @handle in a message (lower-cased), as the renderer would mark them. */
export function mentionsIn(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/(?<![\w@])@([a-z0-9_]{3,32})(?!\w)/gi)) out.add(m[1].toLowerCase());
  return out;
}

/** Only plain http(s) links become anchors; trailing punctuation stays text. */
function splitLink(raw) {
  const m = raw.match(/^(.*?)([.,;:!?)\]}]+)$/);
  const href = m ? m[1] : raw;
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch { return null; }
  return { href, tail: m ? m[2] : "" };
}

function inline(text, ctx, keyBase) {
  const out = [];
  let at = 0;
  let n = 0;
  const leaf = (s) => (s ? out.push(ctx.leaf(s, `${keyBase}t${n++}`)) : null);
  for (const m of text.matchAll(INLINE)) {
    leaf(text.slice(at, m.index));
    const [tok] = m;
    const k = `${keyBase}k${n++}`;
    if (m[1]) {
      out.push(<code key={k} className="bg-[rgba(140,136,128,.25)] px-1 py-px font-mono text-[0.9em]">{tok.slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={k} className="font-semibold">{inline(tok.slice(2, -2), ctx, k)}</strong>);
    } else if (m[3] || m[4]) {
      out.push(<em key={k}>{inline(tok.slice(1, -1), ctx, k)}</em>);
    } else if (m[5]) {
      const link = splitLink(tok);
      if (!link) leaf(tok);
      else {
        out.push(
          <a key={k} href={link.href} target="_blank" rel="noopener noreferrer nofollow"
            className="underline decoration-current/40 underline-offset-2 hover:decoration-current">{link.href}</a>,
        );
        leaf(link.tail);
      }
    } else if (m[6]) {
      const isMe = ctx.me && tok.slice(1).toLowerCase() === ctx.me.toLowerCase();
      out.push(
        <span key={k} data-mention={tok.slice(1).toLowerCase()}
          className={`px-0.5 font-medium ${isMe ? "bg-acid text-ink-950" : "bg-[rgba(140,136,128,.25)]"}`}>{tok}</span>,
      );
    }
    at = m.index + tok.length;
  }
  leaf(text.slice(at));
  return out;
}

export function RichText({ text, me, leaf = (s) => s }) {
  const ctx = { me, leaf: (s, key) => <React.Fragment key={key}>{leaf(s)}</React.Fragment> };
  const parts = String(text).split(/```(?:[a-z0-9-]*\n)?([\s\S]*?)```/i);
  // split() with one capture group alternates: text, block, text, block, …
  return parts.map((p, i) => (i % 2
    ? <pre key={`b${i}`} className="my-1 overflow-x-auto border-l-2 border-blood bg-[rgba(140,136,128,.18)] p-2.5 font-mono text-[12px] leading-relaxed">{p.replace(/\n$/, "")}</pre>
    : <React.Fragment key={`p${i}`}>{inline(p, ctx, `p${i}`)}</React.Fragment>));
}
