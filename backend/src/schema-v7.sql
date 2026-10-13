-- NomadVNC backend schema, v7: one session per signed-in device.
--
-- Tokens carry the session id (sid). Signing out revokes only that row,
-- so other devices stay signed in. "Sign out everywhere" still bumps
-- users.credential_version, which ends every token at once.

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
