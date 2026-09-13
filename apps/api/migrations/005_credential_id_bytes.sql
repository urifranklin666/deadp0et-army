-- Registration used to store Buffer.from(credential.id) where credential.id is
-- a base64url string, i.e. the ASCII text of the encoding rather than the raw
-- credential ID. login/finish looks up the raw bytes, so no passkey could ever
-- sign in. Re-decode every row that is still text. Raw IDs are random bytes;
-- the odds of one consisting solely of base64url characters are ~2^-32, and
-- this runs exactly once.
UPDATE webauthn_credentials
   SET credential_id = decode(
         rpad(translate(encode(credential_id, 'escape'), '-_', '+/'),
              length(credential_id) + (4 - length(credential_id) % 4) % 4, '='),
         'base64')
 WHERE encode(credential_id, 'escape') ~ '^[A-Za-z0-9_-]+$';
