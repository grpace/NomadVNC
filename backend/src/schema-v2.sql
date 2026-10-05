-- NomadVNC backend schema, v2 (H1: devices + encrypted credentials).

CREATE TABLE IF NOT EXISTS data_keys (
  id text PRIMARY KEY,
  key bytea NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tailscale_stable_id text NOT NULL,
  dns_name text,
  last_known_ip text,
  vnc_port integer NOT NULL,
  label text NOT NULL,
  collection_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, tailscale_stable_id, vnc_port)
);

CREATE INDEX IF NOT EXISTS devices_owner_id_idx ON devices(owner_id);

CREATE TABLE IF NOT EXISTS device_credentials (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  alg text NOT NULL DEFAULT 'aes-256-gcm',
  key_id text NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
