-- Repair passkey credential ids stored in the wrong form.
--
-- Registration stored Buffer.from(credential.id) — the UTF-8 bytes of the
-- base64url STRING — while login looks credentials up by the raw id bytes and
-- offers the authenticator base64url(stored bytes). The two never matched, so
-- signing in with a passkey always failed; only the session cookie from
-- registration ever let anyone in.
--
-- Decode the affected rows. Only rows whose bytes are entirely the base64url
-- alphabet are touched; a correctly stored raw id is not valid text of that
-- shape (and would show backslash escapes below), so it is left alone.

UPDATE webauthn_credentials
   SET credential_id = decode(
         rpad(translate(convert_from(credential_id, 'UTF8'), '-_', '+/'),
              ((length(credential_id) + 3) / 4) * 4, '='),
         'base64')
 WHERE encode(credential_id, 'escape') ~ '^[A-Za-z0-9_-]+$'
   AND length(credential_id) >= 16;
