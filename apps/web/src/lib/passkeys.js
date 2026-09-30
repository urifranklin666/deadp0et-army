import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api.js";

/**
 * Passkey ceremonies. Separate from session.js so the sign-in screen needs
 * only WebAuthn, not the MLS stack; the console loads that in the background.
 */

export async function register(handle) {
  const { userId, options } = await api.post("/api/auth/register/start", { handle });
  const attResp = await startRegistration({ optionsJSON: options });
  return api.post("/api/auth/register/finish", { userId, response: attResp });
}

export async function login(handle) {
  const { options } = await api.post("/api/auth/login/start", { handle });
  const assertion = await startAuthentication({ optionsJSON: options });
  return api.post("/api/auth/login/finish", { response: assertion, challenge: options.challenge });
}

/**
 * Run `fn`; if the server wants a fresh passkey proof first (it does for
 * passkey changes and account deletion), do the step-up ceremony and retry
 * once. Within the server's window, later sensitive calls don't prompt again.
 */
export async function withReauth(fn) {
  const stepUp = async () => {
    const { options } = await api.post("/api/auth/reauth/start", {});
    const assertion = await startAuthentication({ optionsJSON: options });
    await api.post("/api/auth/reauth/finish", { response: assertion });
  };
  if (!(await api.get("/api/auth/reauth").catch(() => ({ recent: false }))).recent) await stepUp();
  try {
    return await fn();
  } catch (e) {
    // The proof lapsed between the check and the call: once more.
    if (e.status !== 403 || e.message !== "reauth_required") throw e;
    await stepUp();
    return fn();
  }
}

/** Register another passkey for the signed-in account (a backup). */
export function addPasskey() {
  return withReauth(async () => {
    const { options } = await api.post("/api/auth/passkeys/start", {});
    const attResp = await startRegistration({ optionsJSON: options });
    return api.post("/api/auth/passkeys/finish", { response: attResp });
  });
}
