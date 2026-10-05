# Mobile native setup

The React Native JS (`apps/mobile/src`) is complete and typechecked. The
native shells (`apps/mobile/ios`, `apps/mobile/android`) are generated
from the React Native 0.79.2 template and committed — including the
NomadVNC native modules, viewer assets, and all platform wiring below.
CI builds the sideload release APK (`package-android` in
`.github/workflows/ci.yml`) and attaches `NomadVNC-<version>.apk` to
GitHub Releases. iOS is still a local or simulator build. Android debug
builds on Linux are §5a.

Native sources in the repo:

- iOS: `apps/mobile/ios/NomadVNC/NomadNativeModule.{swift,m}` (wired into
  `NomadVNC.xcodeproj`: Sources + Embed Frameworks for `Mobile.xcframework`),
  `apps/mobile/ios/NomadVNC/ViewerAssets/` (folder reference → app bundle),
  `apps/mobile/ios/Podfile` (adds `GCDWebServer`)
- Android: `apps/mobile/android/app/src/main/java/com/nomadvnc/NomadNative{Module,Package}.kt`
  (package registered in `MainApplication.kt`), `libs/mobile.aar` dependency
  + `androidx.security:security-crypto` in `app/build.gradle`,
  `res/xml/network_security_config.xml` (cleartext only for 127.0.0.1)
  referenced from `AndroidManifest.xml`

## 0. Prerequisites (local builds only)

- Xcode 16+ (iOS) and/or the Android SDK (platform 35, build-tools 35.0.0)
- **JDK 17** for Gradle 8.13 (JDK 25 is too new — Gradle fails to run)
- Android NDK `27.1.12297006` (the version pinned in `android/build.gradle`)
- Go (per `go-core/go.mod`) with `gomobile` + `gobind`:
  `go install golang.org/x/mobile/cmd/gomobile@latest golang.org/x/mobile/cmd/gobind@latest`
- Node 22, pnpm 10 (`pnpm install` at the repo root)

## 1. Refresh the viewer assets (any machine)

```sh
node scripts/sync-mobile-viewer-assets.mjs
```

Bundles `@novnc/novnc` to a single ESM module and copies
`packages/viewer-shell/src/bootstrap.mjs` into both
`apps/mobile/ios/NomadVNC/ViewerAssets/` and
`apps/mobile/android/app/src/main/assets/viewer/`. Re-run after changing
either input. Commit the outputs — they are the files the native asset
servers serve.

## 2. Native projects

The `ios/` and `android/` projects are generated from the React Native
0.79.2 template (`npx @react-native-community/cli init --version 0.79.2`)
and committed. Regenerate only when upgrading React Native:

```sh
cd /tmp
npx -y @react-native-community/cli init NomadVNCTmp --version <new-version> --skip-install
# merge ios/ and android/ over apps/mobile/ios and apps/mobile/android,
# then re-apply the NomadVNC wiring (bundle id com.nomadvnc.mobile /
# applicationId com.nomadvnc, native modules, asset config — see git
# history for the exact edits)
```

## 2a. CI builds

`package-android` (ubuntu-latest) installs JDK 17 and the Android SDK,
runs `gomobile bind -target=android/arm64,android/amd64`, then
`./gradlew assembleRelease`. The APK is arm64-v8a and x86_64. On a
version tag it is signed with the upload keystore secrets from
[releasing](../../docs/releasing.md) and attached to the GitHub Release
as `NomadVNC-<version>.apk`. That file is the sideload install. Play
still wants `bundleRelease`.

`mobile-ios` is not in CI yet. Locally: `gomobile bind -target=ios,iossimulator`
the xcframework, `pod install`, then an unsigned simulator compile:

```sh
xcodebuild -workspace NomadVNC.xcworkspace -scheme NomadVNC \
  -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO
```

The `.app` is a local simulator build. It is not uploaded anywhere.

## 3. Build the GoMobile bindings

From the repo root:

```sh
cd go-core
# iOS (on a Mac):
gomobile bind -o ../apps/mobile/ios/Mobile.xcframework -target=ios,iossimulator ./mobile
# Android:
gomobile bind -o ../apps/mobile/android/app/libs/mobile.aar -target=android/arm64,android/amd64 ./mobile
```

Both outputs are gitignored build artifacts — rebuild after any
`go-core/mobile` change.

## 4. iOS integration

1. Open `apps/mobile/ios/NomadVNC.xcworkspace` in Xcode (create it via
   `pod install` below if needed).
2. Add to the app target:
   - `ios/NomadVNC/NomadNativeModule.swift` and `NomadNativeModule.m`
     (the `.m` only declares the bridge; ensure a bridging header exists —
     the RN template provides one),
   - `ios/NomadVNC/ViewerAssets/` as a **folder reference** (blue folder,
     not a group) so it lands in the bundle intact,
   - `ios/Mobile.xcframework` (Embed & Sign).
3. Podfile — add `pod 'GCDWebServer', '~> 3.5'`, then `pod install`.
4. `Info.plist` — allow the loopback asset server and `ws://` session URLs:
   ```xml
   <key>NSAppTransportSecurity</key>
   <dict>
     <key>NSAllowsLocalNetworking</key>
     <true/>
   </dict>
   ```
5. Build & run: `npx react-native run-ios` from `apps/mobile`.

## 5. Android integration

1. `android/app/build.gradle`:
   ```gradle
   dependencies {
       implementation files('libs/mobile.aar')
       implementation "androidx.security:security-crypto:1.1.0-alpha06"
       // …rest of the template's dependencies
   }
   ```
2. `MainApplication.kt` (or `.java`) — register the package:
   ```kotlin
   import com.nomadvnc.NomadNativePackage
   // inside getPackages():
   add(NomadNativePackage())
   ```
3. `AndroidManifest.xml` — the viewer assets and VNC sessions use
   cleartext loopback HTTP/WS. Prefer a scoped network security config
   (`res/xml/network_security_config.xml`):
   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <network-security-config>
     <domain-config cleartextTrafficPermitted="true">
       <domain includeSubdomains="false">127.0.0.1</domain>
     </domain-config>
   </network-security-config>
   ```
   and reference it from the `<application>` tag:
   `android:networkSecurityConfig="@xml/network_security_config"`.
4. Build & run: `npx react-native run-android` from `apps/mobile`.

## 5a. Android on Linux — verified recipe (2026-10-02)

```sh
export JAVA_HOME=/path/to/jdk-17 PATH=$JAVA_HOME/bin:$HOME/go/bin:$PATH
export ANDROID_HOME=$HOME/Android/Sdk ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006
# 1. Go engine → AAR (add android/arm64 for real phones)
cd go-core && gomobile bind -androidapi 24 \
  -o ../apps/mobile/android/app/libs/mobile.aar -target=android/arm64,android/amd64 ./mobile
# 2. APK
cd ../apps/mobile/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
# 3. Debug builds load JS from Metro
cd .. && npx react-native start      # separate terminal
adb reverse tcp:8081 tcp:8081
```

Notes: `metro.config.js` is set up for the pnpm monorepo (watches
`packages/` and the root `node_modules` store). Restart Metro after
`pnpm install` — it crashes if the store changes under its watcher.
Debug builds allow cleartext to the Metro host via
`app/src/debug/res/xml/network_security_config.xml`; release builds keep
loopback-only. Emulator tip: the host machine is `10.0.2.2`.

iOS: after pulling, run `pod install` in `apps/mobile/ios` — the app now
also autolinks `react-native-safe-area-context`. Current Xcode requires
the UIScene lifecycle (`UIApplicationSceneManifest` and `SceneDelegate`
in `AppDelegate.swift`); without it the simulator traps at launch. The
Debug configuration sets `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG`
so the app loads JavaScript from Metro. The Podfile also keeps fmt 11
building on that Xcode, and quotes the React Native script phases so a
checkout path with a space still bundles.

## 6. Smoke test (either platform)

1. Launch the app. Nothing starts Tailscale until you tap "Sign in with
   Tailscale" (the browser opens to approve the device).
2. **Local-first check (no Tailscale login needed):** type a manual host/IP
   (e.g. a LAN machine running a VNC server), port, and password, then
   Connect. The engine dials via the OS network (`direct: true`).
3. The viewer WebView loads `viewer-runtime.js`, `viewer-bootstrap.mjs`,
   and `viewer-input.mjs` from the native loopback server and the noVNC
   canvas renders. Two-finger tap right-clicks; **Keyboard** opens the
   phone keyboard with the extra-keys bar above it.
4. Wrong password → "Authentication failed" screen (no retry loop); wrong
   port → "Couldn't connect" without retries.
5. Save a device under My Devices (local mode keeps it on the phone,
   password in the keychain); tapping it connects with no typing.
6. Disconnect stops the session proxy (check the app logs for errors).

## Architecture notes

- **Viewer assets are not loaded with a custom URL scheme.** An earlier
  sketch used `nomadvnc://` URLs inside the WebView, which requires
  `WKURLSchemeHandler` to be installed before the WKWebView is created —
  react-native-webview doesn't expose that. The loopback HTTP server in
  the native module serves the same files with
  `Access-Control-Allow-Origin: *`, and `http://127.0.0.1:*` is already in
  the shared viewer CSP's `script-src`. Account sign-in is separate: iOS
  and Android register `nomadvnc://auth/callback` so a magic-link email
  can open the app.
- **Events:** the engine's event channel is drained by `PollEvents()` (see
  `go-core/mobile/mobile.go`) every 500ms; the native modules normalize
  Go's `statePayload` key to the JS contract's `state` before emitting
  `NomadNativeEvent` — the same mapping the desktop sidecar manager does.
- **Secure storage:** iOS Keychain (`kSecAttrAccessibleAfterFirstUnlock`),
  Android EncryptedSharedPreferences (Keystore). Keys are namespaced in
  `apps/mobile/src/native/NomadNativeModule.ts`
  (`vnc-password:<machineId>`, `account-token`).
