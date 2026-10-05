/**
 * Builds and stages the mobile WebView viewer assets.
 *
 * The mobile viewer (apps/mobile) loads its JavaScript from the native
 * module's loopback HTTP asset server — no custom URL scheme, no WebView
 * surgery, and no CSP changes (http://127.0.0.1:* is already allowed).
 * This script produces the two served files:
 *
 *   viewer-runtime.js    — @novnc/novnc bundled to a single ESM module whose
 *                          default export is the RFB class
 *   viewer-bootstrap.mjs — packages/viewer-shell bootstrap (imports the
 *                          runtime URL from the viewer config block)
 *   viewer-input.mjs     — packages/viewer-shell touch gestures + typing
 *
 * Outputs (native projects consume them from here):
 *   apps/mobile/ios/NomadVNC/ViewerAssets/
 *   apps/mobile/android/app/src/main/assets/viewer/
 *
 * Run: `node scripts/sync-mobile-viewer-assets.mjs`
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerShellRequire = createRequire(path.join(root, "packages/viewer-shell", "package.json"));

function findEsbuild() {
  const pnpmDir = path.join(root, "node_modules", ".pnpm");
  const bins = readdirSync(pnpmDir)
    .filter((d) => d.startsWith("esbuild@"))
    .map((d) => path.join(pnpmDir, d, "node_modules", "esbuild", "bin", "esbuild"))
    .filter(existsSync)
    .sort();
  if (bins.length === 0) {
    throw new Error("esbuild binary not found under node_modules/.pnpm — run pnpm install first");
  }
  return bins[bins.length - 1];
}

function main() {
  const novncPkg = path.dirname(viewerShellRequire.resolve("@novnc/novnc/package.json"));
  const novncLib = path.join(novncPkg, "lib");
  const entry = path.join(novncLib, "rfb.js");
  if (!existsSync(entry)) {
    throw new Error(`noVNC entry not found: ${entry}`);
  }

  // noVNC's Babel-compiled lib/util/browser.js uses a top-level await for
  // a WebCodecs feature probe. esbuild wraps that module in an async
  // CommonJS shim whose callback receives no (module, exports) arguments,
  // so the bare `exports` references throw at load time. Bundle from a
  // patched copy where the probe resolves asynchronously instead — the
  // flag is only read later when negotiating H264, by which time the
  // promise has settled.
  const patchedPkg = path.join(tmpdir(), "nomadvnc-novnc-pkg");
  execFileSync("rm", ["-rf", patchedPkg]);
  execFileSync("cp", ["-r", novncPkg + "/", patchedPkg + "/"]);
  const patchedLib = path.join(patchedPkg, "lib");
  const browserJs = path.join(patchedLib, "util", "browser.js");
  const tlaLine =
    "exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();";
  const browserSrc = readFileSync(browserJs, "utf8");
  if (!browserSrc.includes(tlaLine)) {
    throw new Error(`expected top-level await not found in ${browserJs} — noVNC layout changed?`);
  }
  writeFileSync(
    browserJs,
    browserSrc.replace(
      tlaLine,
      "exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = false;\n" +
        "_checkWebCodecsH264DecodeSupport().then(function (v) {\n" +
        "  exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = v;\n" +
        "}, function () {});",
    ),
  );

  // esbuild's CJS->ESM interop makes the bundle's default export the whole
  // `module.exports` object (`.default` = the RFB class). The viewer
  // bootstrap does `const { default: RFB } = await import(url)` and calls
  // `new RFB(...)`, so re-export the class itself as the default export.
  const wrapperEntry = path.join(tmpdir(), "nomadvnc-viewer-runtime-entry.mjs");
  writeFileSync(
    wrapperEntry,
    `import rfbModule from ${JSON.stringify(path.join(patchedLib, "rfb.js"))};\n` +
      `const RFB = rfbModule && rfbModule.default ? rfbModule.default : rfbModule;\n` +
      `export default RFB;\n`,
  );

  const outFile = path.join(tmpdir(), "nomadvnc-viewer-runtime.js");
  execFileSync(findEsbuild(), [wrapperEntry, "--bundle", "--format=esm", "--minify", `--outfile=${outFile}`], {
    stdio: "inherit",
  });

  const bootstrapSrc = path.join(root, "packages", "viewer-shell", "src", "bootstrap.mjs");
  if (!existsSync(bootstrapSrc)) {
    throw new Error(`viewer bootstrap not found: ${bootstrapSrc}`);
  }

  const inputSrc = path.join(root, "packages", "viewer-shell", "src", "input.mjs");

  const targets = [
    path.join(root, "apps", "mobile", "ios", "NomadVNC", "ViewerAssets"),
    path.join(root, "apps", "mobile", "android", "app", "src", "main", "assets", "viewer"),
  ];
  for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(outFile, path.join(dir, "viewer-runtime.js"));
    copyFileSync(bootstrapSrc, path.join(dir, "viewer-bootstrap.mjs"));
    copyFileSync(inputSrc, path.join(dir, "viewer-input.mjs"));
    // Marker so future runs and the native setup doc can verify provenance.
    writeFileSync(
      path.join(dir, "ASSETS.md"),
      "# Mobile viewer assets (generated)\n\n" +
        "Do not edit by hand — regenerate with `node scripts/sync-mobile-viewer-assets.mjs`.\n\n" +
        "- `viewer-runtime.js`: @novnc/novnc bundled to one ESM module (default export: RFB)\n" +
        "- `viewer-bootstrap.mjs`: copy of packages/viewer-shell/src/bootstrap.mjs\n" +
        "- `viewer-input.mjs`: copy of packages/viewer-shell/src/input.mjs\n",
    );
    console.log(`staged ${dir}`);
  }
}

main();
