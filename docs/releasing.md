# Releasing

## How a release is built

`.github/workflows/ci.yml` runs on every pull request, on `v*` tags (an
app release), and on `host-v*` tags (a NomadVNC Host release on its own;
see [Releasing only NomadVNC Host](#releasing-only-nomadvnc-host)):

| Job | Runner | Produces |
|---|---|---|
| `js` | Ubuntu | typecheck + JS tests |
| `go` | Ubuntu | `go vet` + Go tests |
| `package-linux` | Ubuntu | AppImage, `.deb`, `.rpm`, `latest-linux.yml`; also the shared icon set |
| `package-mac` | macOS | Apple Silicon `.dmg` + `.zip`, `latest-mac.yml` |
| `package-windows` | Windows | x64 NSIS installer, `latest.yml`, and `NomadVNC-Host-<version>-x64.exe` |
| `package-android` | Ubuntu | `NomadVNC-<version>.apk` (sideload; not the Play bundle) |

On pull requests the packages are uploaded as workflow artifacts for
testing. On a `v*` tag (or a manual run on that tag with `publish: true`;
a manual run on a branch never publishes) the
`release-draft` job creates a draft GitHub Release, each package job
attaches its files, and `release-publish` publishes the draft as Latest
once every package job has succeeded. Until then the previous release
stays Latest, so its download links and the auto-updater keep working.
If a package job fails, the draft stays a draft: fix forward with the next
patch version. The `latest*.yml` files are what the apps' auto-updater
reads, so always publish them with the binaries.

Each package job also attaches a copy of every installer without the
version in its name (`NomadVNC-x64.exe`, `NomadVNC-Host-x64.exe`,
`NomadVNC.apk`, and so on; see `scripts/copy-latest-names.mjs`). Links of
the form `https://github.com/grpace/NomadVNC/releases/latest/download/<name>`
therefore always serve the newest release, and the download page at
greg.tech/nomadvnc uses them, so it needs no edit per release.

The Go sidecar is cross-compiled per platform and bundled under
`resources/sidecar/` in each package; it updates with the app.

NomadVNC Host is a separate Windows download, `NomadVNC-Host-<version>-x64.exe`.
It is not inside the viewer installer, and it is not listed in `latest.yml`,
so the viewer auto-updater does not replace it. Its version is its own,
in `go-core/cmd/nomadvnc-host/VERSION`, not the apps' `package.json`
version. The `go` job cross-compiles it on every run. The Windows package
job builds it again and attaches that exe to the same Release as the
viewer. It stays unsigned even when the viewer installer is signed.

## Cutting a release

1. Update `CHANGELOG.md` and bump `version` in the root
   `package.json`, `apps/desktop/package.json`, `apps/mobile/package.json`,
   and `backend/package.json`. For mobile, also bump `versionName` +
   `versionCode` in `apps/mobile/android/app/build.gradle` and
   `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` in the iOS project
   (the build numbers must increase for the app stores). If the host
   changed too, bump `go-core/cmd/nomadvnc-host/VERSION`.
2. Merge to `master`.
3. Tag and push:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
4. Check the Release page: AppImage, `.deb`, `.rpm`, `.dmg`, `.zip`,
   the viewer `.exe`, `NomadVNC-Host-<version>-x64.exe`,
   `NomadVNC-<version>.apk`, the version-free copy of each of those,
   and the three `latest*.yml` files.

## Releasing only NomadVNC Host

When only the host changed, release it without rebuilding the apps:

1. Update `CHANGELOG.md` and bump `go-core/cmd/nomadvnc-host/VERSION`
   (only that; the apps keep their version).
2. Merge to `master`.
3. Tag and push with the host version:
   ```bash
   git tag host-v1.3.3
   git push origin host-v1.3.3
   ```
   The `release-host` job checks the tag against `VERSION` and fails if
   they differ.
4. The job builds only the host, in a few minutes. It creates a
   `host-v1.3.3` release holding `NomadVNC-Host-1.3.3-x64.exe`, never
   marked Latest (the apps' auto-updater reads Latest). On the current
   Latest app release it swaps the host: the new versioned exe and
   `NomadVNC-Host-x64.exe` go up, and the older versioned host exe is
   deleted, so that release always carries exactly one host. The site's
   `releases/latest/download/NomadVNC-Host-x64.exe` link then serves the
   new host with no site change.

The next app release attaches whatever host `VERSION` says, so the host
on Latest never goes backwards.

**Never move or re-create a published tag** — it breaks `git pull` for
everyone who fetched it and confuses the auto-updater. Fix forward with
the next patch version.

## Building packages locally

```bash
pnpm desktop:package:linux   # → apps/desktop/release/
pnpm desktop:package:mac     # on a Mac
pnpm desktop:package:win     # on Windows
pnpm build:host              # → go-core/bin/nomadvnc-host.exe
pnpm build:host -- --release # also copies NomadVNC-Host-<host version>-x64.exe
                             # into apps/desktop/release/
```

Run `pnpm build:host -- --release` after `pnpm desktop:package:win`. The
viewer package step clears `apps/desktop/release/` first. The build
gives the exe its version (from `package.json`), a manifest, and the icon
`pnpm icons` renders into `apps/desktop/build/icon.ico`; without that file
the exe is built with the plain Windows program icon.

Icon generation drives a hidden Electron window, so it needs a display
(`xvfb-run -a pnpm desktop:package:linux` on a headless machine). The Go
build targets the machine you build on; for another architecture build
on that architecture or cross-compile `go-core` first
(`GOOS=… GOARCH=… pnpm build:go`).

## Code signing

Unsigned builds work, but macOS Gatekeeper and Windows SmartScreen warn
on first launch (see [install.md](guides/install.md)). The CI jobs sign
automatically when these repository secrets exist and skip signing when
they don't.

### macOS — Developer ID + notarization

Requires an Apple Developer Program membership.

1. Create a **Developer ID Application** certificate (Xcode → Settings →
   Accounts, or developer.apple.com) and install it in your keychain.
2. In Keychain Access, export its private key as a `.p12` with a strong
   password.
3. At appleid.apple.com, create an **app-specific password** for
   notarization.
4. Add repository secrets:

   | Secret | Value |
   |---|---|
   | `MAC_CSC_LINK` | `base64 -i cert.p12` |
   | `MAC_CSC_KEY_PASSWORD` | the `.p12` password |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | from step 3 |
   | `APPLE_TEAM_ID` | the 10-character team ID |

5. Delete the local `.p12` or store it offline. Never commit it.

### Windows installer

`apps/desktop/package.json` builds an assisted NSIS installer
(`oneClick: false`). The wizard offers a per-user or per-machine
install, the install folder, and a finish checkbox to start the app.
Start menu and desktop shortcuts are created. `nomadvnc://` is
registered for account sign-in.

The uninstaller is registered in Windows Settings and can also be opened
from **Settings → Updates** in the app. It asks whether to remove that
Windows account's NomadVNC data. Silent uninstalls and updates pass
`--updated` and do not ask or delete that data
(`apps/desktop/installer.nsh`).

The executable version resource (product name, company, copyright,
version) comes from `apps/desktop/package.json`. The app id
`com.nomadvnc.desktop` is also the Windows AppUserModelID. The NSIS
`guid` is the Apps & Features identity. Do not change it after the first
public installer, or Windows will treat the next build as a different
program.

`requestedExecutionLevel` is `asInvoker`. The executable keeps Electron's
application manifest (per-monitor DPI, no administrator requirement).

### Windows — code-signing certificate

1. Buy an OV or EV code-signing certificate from a CA (EV gets
   SmartScreen reputation immediately; OV builds it over time).
2. Export it as a `.pfx` with a password.
3. Add secrets `WIN_CSC_LINK` (base64 of the `.pfx`) and
   `WIN_CSC_KEY_PASSWORD`.

To sign a local build, export the same values as `CSC_LINK`,
`CSC_KEY_PASSWORD` (and the `APPLE_*` variables on macOS) before running
the package command.

## Mobile

Debug builds and the Android/iOS build steps are in
[apps/mobile/NATIVE_SETUP.md](../apps/mobile/NATIVE_SETUP.md).

Listing copy, phone screenshots, the Play feature graphic, the
512×512 icon, and the iPhone and iPad screenshots are in
[apps/mobile/store](../apps/mobile/store). Paste those into Play
Console and App Store Connect after the developer accounts exist.
Nothing in that folder has been submitted.

### Android — Play upload key

`bundleRelease` / `assembleRelease` sign with the upload key named in
`~/.gradle/gradle.properties` (mode 600; never commit the keystore or
these values):

| Property | Value |
|---|---|
| `NOMADVNC_UPLOAD_STORE_FILE` | absolute path to the `.jks` |
| `NOMADVNC_UPLOAD_STORE_PASSWORD` | keystore password |
| `NOMADVNC_UPLOAD_KEY_ALIAS` | key alias |
| `NOMADVNC_UPLOAD_KEY_PASSWORD` | key password |

Without those properties the release build falls back to the debug key
and Gradle warns. That APK is fine for a local smoke test and is
rejected by the Play Store. Losing the upload key means you can never
ship an update to the same Play listing, so keep a backup offline.

The GitHub Release includes a sideload APK, `NomadVNC-<version>.apk`,
built with `assembleRelease`. It is not uploaded to Play. CI signs it
with the same upload key when these repository secrets are set, so a
later Play update can replace that install:

| Secret | Value |
|---|---|
| `ANDROID_UPLOAD_STORE_BASE64` | base64 of the `.jks` |
| `ANDROID_UPLOAD_STORE_PASSWORD` | keystore password |
| `ANDROID_UPLOAD_KEY_ALIAS` | key alias |
| `ANDROID_UPLOAD_KEY_PASSWORD` | key password |

A tag build fails closed if those secrets are missing, instead of
publishing an APK signed with a throwaway debug key. People who already
installed the release APK could not update over a different signature.

The Play Store takes the Android App Bundle:

```bash
cd apps/mobile/android && ./gradlew bundleRelease
# → app/build/outputs/bundle/release/app-release.aab
```

The sideload APK from the same key:

```bash
cd apps/mobile/android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

The Go engine inside that bundle has to include `android/arm64` (real
phones) as well as `android/amd64` (the emulator). See the `gomobile
bind` line in `NATIVE_SETUP.md`.

### iOS — export compliance

Store signing needs an Apple Developer account. `Info.plist` sets
`ITSAppUsesNonExemptEncryption` to false, so each upload skips Apple's
encryption questionnaire: the app only uses standard encryption (TLS,
and Tailscale's WireGuard for its own traffic). If review disagrees,
flip the key to true and answer the questionnaire.
