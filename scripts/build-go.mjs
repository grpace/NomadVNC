import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const goCore = path.join(scriptDir, "..", "go-core");
mkdirSync(path.join(goCore, "bin"), { recursive: true });

// Cross-compilation: GOOS/GOARCH env vars win (CI builds mac/Windows
// sidecars from Linux). Otherwise build for the host.
const env = { ...process.env };
if (!env.GOOS) {
  env.GOOS = process.platform === "win32" ? "windows" : process.platform;
}
if (!env.GOARCH) {
  env.GOARCH = process.arch === "arm64" ? "arm64" : "amd64";
}
const binaryName = env.GOOS === "windows" ? "nomadvnc-sidecar.exe" : "nomadvnc-sidecar";
const outPath = path.join("bin", binaryName);
console.log(`build:go: GOOS=${env.GOOS} GOARCH=${env.GOARCH} -> ${outPath}`);
const result = spawnSync("go", ["build", "-o", outPath, "./cmd/nomadvnc-sidecar"], {
  cwd: goCore,
  stdio: "inherit",
  env,
});

if (result.error) {
  console.error("\nbuild:go: could not run `go`:", result.error.message);
  console.error("Install the Go version in go-core/go.mod and add it to PATH.");
  console.error("Then run: pnpm build:go\n");
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
