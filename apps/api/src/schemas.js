/**
 * Shared JSON-schema fragments for route validation.
 *
 * Fastify validates before the handler runs, so a malformed id becomes a 400
 * with a message instead of a Postgres 22P02 turned into a 500, and every
 * string the client can send has a ceiling.
 */

export const UUID = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
};

/** Standard base64 (what the client's b64() emits), capped in characters. */
export const B64 = (maxLength) => ({ type: "string", pattern: "^[A-Za-z0-9+/]+={0,2}$", minLength: 1, maxLength });

export const HANDLE = { type: "string", pattern: "^[a-z0-9_]{3,32}$" };
export const SLUG = { type: "string", pattern: "^[a-z0-9-]{2,48}$" };
export const SUITE_NAME = { type: "string", minLength: 1, maxLength: 128 };
export const GROUP_ID = B64(64);           // 16 raw bytes → 24 chars; room for larger ids

export const obj = (properties, required = []) => ({ type: "object", properties, required });
