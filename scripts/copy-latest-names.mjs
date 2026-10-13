#!/usr/bin/env node
// Copies each release file to a name without the version
// (NomadVNC-1.2.0-x64.exe -> NomadVNC-x64.exe) so that
// https://github.com/grpace/NomadVNC/releases/latest/download/<name>
// always serves the newest build. Usage: node scripts/copy-latest-names.mjs <dir>
import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dir = process.argv[2];
if (!dir) {
  console.error("usage: copy-latest-names.mjs <release dir>");
  process.exit(1);
}

const tag = `-${version}`;
const installer = /\.(AppImage|deb|rpm|dmg|zip|exe|apk)$/;
for (const name of readdirSync(dir)) {
  if (!name.includes(tag) || !installer.test(name)) continue;
  const latest = name.replace(tag, "");
  copyFileSync(join(dir, name), join(dir, latest));
  console.log(`${name} -> ${latest}`);
}
