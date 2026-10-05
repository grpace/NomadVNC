-- NomadVNC backend schema, v3 (H3: per-device email grants + encrypted tailnet auth keys).
--
-- A share is ongoing, not one-time: the grant row + encrypted key persist so
-- the grantee can reconnect until revoked or the key expires. "Ephemeral"
-- describes the per-session tsnet node client-side, never the grant.
-- Revocation (revoked_at) stops VNC-password releases immediately.

CREATE TABLE IF NOT EXISTS shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  grantee_email citext NOT NULL,
  permission text NOT NULL DEFAULT 'connect',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- One live grant per (device, grantee); re-sharing after revoke is a new row.
CREATE UNIQUE INDEX IF NOT EXISTS shares_live_grant_uniq
  ON shares (device_id, grantee_email) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS shares_grantee_idx ON shares(grantee_email) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS shares_device_idx ON shares(device_id) WHERE revoked_at IS NULL;

-- Encrypted tailnet auth key per share (same AES-256-GCM envelope as
-- device_credentials, §3). expires_at tracks the Tailscale key expiry so the
-- API can surface keyExpiresInDays warnings before the grantee is locked out.
-- No row = same-tailnet share (no key needed), which never expires.
CREATE TABLE IF NOT EXISTS share_keys (
  share_id uuid PRIMARY KEY REFERENCES shares(id) ON DELETE CASCADE,
  alg text NOT NULL DEFAULT 'aes-256-gcm',
  key_id text NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
