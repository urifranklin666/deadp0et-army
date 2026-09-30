import "./env.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuration read in more than one place, so every reader agrees.
 * (Three copies of the RP_ORIGIN fallback had already been written.)
 */

// Passkeys are bound to these. The fallbacks are for development only; the
// server warns at startup when they're in use.
export const RP_ID = process.env.RP_ID || "localhost";
export const RP_ORIGIN = process.env.RP_ORIGIN || "http://localhost";

// How long a revoked session can keep a WebSocket (presence, hints) open.
export const RECHECK_MS = Number(process.env.PRESENCE_RECHECK_MS) || 60_000;

/**
 * Which X-Forwarded-For hops to believe. Only our own reverse proxies, which
 * reach us over loopback: the client address is then the right-most entry a
 * trusted hop added, not whatever the client wrote at the left. (`true`
 * would trust every entry, letting anyone pick their own IP — and with it
 * their own rate-limit bucket.) TRUST_PROXY overrides, e.g. a CIDR.
 */
export const TRUST_PROXY = process.env.TRUST_PROXY || "loopback";

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Migration files on disk, in the order they apply. */
export const migrationFiles = () =>
  fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
    .map((name) => ({ name, path: path.join(MIGRATIONS_DIR, name) }));
