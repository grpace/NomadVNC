-- NomadVNC backend schema, v5: account deletion links.
--
-- Single-use links now carry a purpose, so an emailed "delete my account"
-- link can never be redeemed as a sign-in, nor a sign-in link as a deletion.

ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'signin';
