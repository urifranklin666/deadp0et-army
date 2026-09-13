import { store } from "./db.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 310000;

const b64 = (bytes) => {
  let s = "";
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function jsonReplacer(_key, value) {
  if (value instanceof Uint8Array) return { __dp_u8: b64(value) };
  if (value instanceof ArrayBuffer) return { __dp_u8: b64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) return { __dp_u8: b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  return value;
}
function jsonReviver(_key, value) {
  return value && typeof value === "object" && value.__dp_u8 ? unb64(value.__dp_u8) : value;
}

async function keyFrom(passphrase, salt, usages) {
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material, { name: "AES-GCM", length: 256 }, false, usages);
}

export async function exportRecovery(handle, passphrase) {
  if (passphrase.length < 12) throw new Error("Recovery passphrase must be at least 12 characters.");
  const all = await store.entries();
  const entries = all.filter(([key]) => String(key).includes(`:${handle}`) || key === `device:${handle}` || key === `kp:${handle}`);
  if (!entries.length) throw new Error("No local device state exists for this handle.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt, ["encrypt"]);
  const payload = enc.encode(JSON.stringify({ version: 1, handle, exportedAt: new Date().toISOString(), entries }, jsonReplacer));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, payload));
  return new Blob([JSON.stringify({ format: "deadp0et-recovery", version: 1, kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt) }, cipher: { name: "AES-256-GCM", nonce: b64(nonce) }, ciphertext: b64(ciphertext) })], { type: "application/vnd.deadp0et.recovery+json" });
}

export async function importRecovery(file, passphrase, expectedHandle) {
  let box;
  try { box = JSON.parse(await file.text()); } catch { throw new Error("That is not a DEADP0ET recovery file."); }
  if (box?.format !== "deadp0et-recovery" || box.version !== 1) throw new Error("Unsupported recovery format.");
  try {
    const key = await keyFrom(passphrase, unb64(box.kdf.salt), ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.cipher.nonce) }, key, unb64(box.ciphertext));
    const data = JSON.parse(dec.decode(plaintext), jsonReviver);
    if (expectedHandle && data.handle !== expectedHandle) throw new Error(`This backup belongs to @${data.handle}, not @${expectedHandle}.`);
    await store.import(data.entries);
    return { handle: data.handle, entries: data.entries.length, exportedAt: data.exportedAt };
  } catch (e) {
    if (e.message?.includes("belongs to")) throw e;
    throw new Error("Recovery failed. The passphrase is wrong or the file was modified.");
  }
}

export function downloadRecovery(blob, handle) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `deadp0et-${handle}-${new Date().toISOString().slice(0,10)}.dpr`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
