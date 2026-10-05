-- NomadVNC backend schema, v4: stop persisting raw data-key material.
--
-- v2 stored each DATA_KEY's bytes in data_keys.key — right next to the
-- ciphertext they protect, so a database dump alone could decrypt every
-- stored VNC password and share key. Keys live only in the environment
-- (DATA_KEY / DATA_KEY_OLD); this table now records fingerprints and the
-- active flag for operators. Values are nulled before the drop so the
-- bytes leave the live tuples; run `VACUUM FULL data_keys` afterwards to
-- scrub them from disk pages immediately instead of waiting for autovacuum.

ALTER TABLE data_keys ALTER COLUMN key DROP NOT NULL;
UPDATE data_keys SET key = NULL;
ALTER TABLE data_keys DROP COLUMN IF EXISTS key;
