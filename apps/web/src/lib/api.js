/** Thin API client. Cookies carry the session, so every call is credentialed. */

const BASE = "";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(json.error || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export const api = {
  get: (p) => call("GET", p),
  post: (p, b) => call("POST", p, b),

  health: () => call("GET", "/api/health"),
  me: () => call("GET", "/api/auth/me"),
  logout: () => call("POST", "/api/auth/logout"),

  channels: () => call("GET", "/api/channels"),
  createChannel: (slug, kind) => call("POST", "/api/channels", { slug, kind }),

  registerDevice: (name, identity) => call("POST", "/api/mls/devices", { name, identity }),
  publishKeyPackages: (deviceId, ciphersuite, keyPackages) =>
    call("POST", "/api/mls/key-packages", { deviceId, ciphersuite, keyPackages }),
  claimKeyPackages: (handle, ciphersuite) =>
    call("GET", `/api/mls/key-packages/${encodeURIComponent(handle)}?ciphersuite=${encodeURIComponent(ciphersuite)}`),

  createGroup: (channelId, groupId, ciphersuite) =>
    call("POST", "/api/mls/groups", { channelId, groupId, ciphersuite }),
  group: (groupId) => call("GET", `/api/mls/groups/${encodeURIComponent(groupId)}`),
  postMessage: (groupId, payload) =>
    call("POST", `/api/mls/groups/${encodeURIComponent(groupId)}/messages`, payload),
  messages: (groupId, since) =>
    call("GET", `/api/mls/groups/${encodeURIComponent(groupId)}/messages?since=${since || 0}`),

  welcomes: (deviceId) => call("GET", `/api/mls/devices/${deviceId}/welcomes`),
  ackWelcomes: (deviceId, ids) => call("POST", `/api/mls/devices/${deviceId}/welcomes/ack`, { ids }),
};
