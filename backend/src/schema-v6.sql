-- NomadVNC backend schema, v6: macOS Screen Sharing username per device.
--
-- Screen Sharing (ARD) asks for the Mac account short name with the
-- password. It is not a secret, so it lives with the device metadata and
-- syncs to the owner's other devices (and to people the device is shared
-- with, who receive the password too).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS vnc_username text;
