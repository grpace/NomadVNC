import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(scriptDir, "..");
const goCore = path.join(root, "go-core");
mkdirSync(path.join(goCore, "bin"), { recursive: true });

const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function fail(result) {
  if (result.error) {
    console.error("\nbuild:host: could not run `go`:", result.error.message);
    console.error("Install the Go version in go-core/go.mod and add it to PATH.");
    console.error("Then run: pnpm build:host\n");
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

// The exe's manifest, version details and icon. The generator runs on this
// machine, so it gets this machine's GOOS; the Go linker then picks the
// .syso up from the package directory. The icon is one `pnpm icons`
// renders for the desktop app, and is left out if it hasn't been run.
const resources = path.join("cmd", "nomadvnc-host", "rsrc_windows_amd64.syso");
fail(
  spawnSync(
    "go",
    [
      "run",
      "./tools/hostres",
      "-version",
      version,
      "-icon",
      path.join(root, "apps", "desktop", "build", "icon.ico"),
      "-out",
      resources,
    ],
    { cwd: goCore, stdio: "inherit" },
  ),
);

// The host is a 64-bit Windows program. Cross-compile from any OS.
// -H=windowsgui: no console window opens beside the setup window. The exe
// borrows the prompt's console when it is given a command there.
const env = { ...process.env, GOOS: "windows", GOARCH: "amd64" };
const outPath = path.join("bin", "nomadvnc-host.exe");
console.log(`build:host: GOOS=windows GOARCH=amd64 version=${version} -> ${outPath}`);
const result = spawnSync(
  "go",
  ["build", "-ldflags", `-H=windowsgui -X main.version=${version}`, "-o", outPath, "./cmd/nomadvnc-host"],
  { cwd: goCore, stdio: "inherit", env },
);

fail(result);

// --release copies a versioned exe next to the viewer packages. Run this
// after the Windows viewer package so electron-builder does not wipe it.
if (process.argv.includes("--release")) {
  const releaseDir = path.join(root, "apps", "desktop", "release");
  mkdirSync(releaseDir, { recursive: true });
  const staged = path.join(releaseDir, `NomadVNC-Host-${version}-x64.exe`);
  copyFileSync(path.join(goCore, outPath), staged);
  console.log(`build:host: staged ${staged}`);
}
