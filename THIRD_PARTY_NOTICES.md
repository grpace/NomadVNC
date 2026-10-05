# Third-party notices

NomadVNC is licensed under Apache-2.0 (see [LICENSE](LICENSE)). It
includes or links the third-party software below, each under its own
license. Full license texts ship with each component's source; the
desktop packages also include Electron's and Chromium's license files.

## Bundled in the apps

| Component | License | Where |
|---|---|---|
| [noVNC](https://github.com/novnc/noVNC) 1.6.0 | MPL-2.0 | Desktop: unmodified source in `apps/desktop/src/renderer/public/vendor/novnc/` (license: `LICENSE.txt` there). Mobile: bundled into `viewer-runtime.js` by `scripts/sync-mobile-viewer-assets.mjs` from the npm package `@novnc/novnc`; the corresponding source is the upstream 1.6.0 release. |
| [pako](https://github.com/nodeca/pako) (via noVNC) | MIT | `apps/desktop/src/renderer/public/vendor/novnc/vendor/pako/` |
| [Electron](https://www.electronjs.org/) and Chromium | MIT; Chromium: BSD-3-Clause and others | Desktop packages (`LICENSE.electron.txt`, `LICENSES.chromium.html`) |
| [React](https://react.dev/), React DOM | MIT | Desktop and mobile |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | Desktop |
| [Inter](https://github.com/rsms/inter) typeface (via `@fontsource/inter`) | SIL Open Font License 1.1 | Desktop |
| [React Native](https://reactnative.dev/) | MIT | Mobile |
| [react-native-webview](https://github.com/react-native-webview/react-native-webview) | MIT | Mobile (with a small local patch in `patches/`) |
| [react-native-keychain](https://github.com/oblador/react-native-keychain) | MIT | Mobile |
| [react-native-safe-area-context](https://github.com/AppAndFlow/react-native-safe-area-context) | MIT | Mobile |
| [GCDWebServer](https://github.com/swisspol/GCDWebServer) | BSD-3-Clause | iOS |
| [AndroidX Security Crypto](https://developer.android.com/jetpack/androidx/releases/security) | Apache-2.0 | Android |

## Go engine (`go-core`, compiled into the desktop sidecar and the mobile libraries)

| Module | License |
|---|---|
| `filippo.io/edwards25519` | BSD-3-Clause |
| `github.com/aws/aws-sdk-go-v2` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/config` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/credentials` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/feature/ec2/imds` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/internal/configsources` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/internal/endpoints/v2` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/internal/ini` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/internal/presigned-url` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/sso` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/ssooidc` | Apache-2.0 |
| `github.com/aws/aws-sdk-go-v2/service/sts` | Apache-2.0 |
| `github.com/aws/smithy-go` | Apache-2.0 |
| `github.com/coder/websocket` | ISC |
| `github.com/creachadair/msync` | BSD-2-Clause |
| `github.com/fxamacker/cbor/v2` | MIT |
| `github.com/gaissmai/bart` | MIT |
| `github.com/go-json-experiment/json` | BSD-3-Clause |
| `github.com/godbus/dbus/v5` | BSD-2-Clause |
| `github.com/golang/groupcache` | Apache-2.0 |
| `github.com/google/btree` | Apache-2.0 |
| `github.com/google/uuid` | BSD-3-Clause |
| `github.com/gorilla/websocket` | BSD-2-Clause |
| `github.com/hdevalence/ed25519consensus` | BSD-3-Clause |
| `github.com/huin/goupnp` | BSD-2-Clause |
| `github.com/jsimonetti/rtnetlink` | MIT |
| `github.com/klauspost/compress` | Apache-2.0 |
| `github.com/mdlayher/netlink` | MIT |
| `github.com/mdlayher/socket` | MIT |
| `github.com/mitchellh/go-ps` | MIT |
| `github.com/pires/go-proxyproto` | Apache-2.0 |
| `github.com/safchain/ethtool` | Apache-2.0 |
| `github.com/tailscale/hujson` | BSD-3-Clause |
| `github.com/tailscale/peercred` | BSD-3-Clause |
| `github.com/tailscale/web-client-prebuilt` | BSD-3-Clause |
| `github.com/tailscale/wireguard-go` | MIT |
| `github.com/x448/float16` | MIT |
| `go4.org/mem` | Apache-2.0 |
| `go4.org/netipx` | BSD-3-Clause |
| `golang.org/x/crypto` | BSD-3-Clause |
| `golang.org/x/exp` | BSD-3-Clause |
| `golang.org/x/net` | BSD-3-Clause |
| `golang.org/x/oauth2` | BSD-3-Clause |
| `golang.org/x/sync` | BSD-3-Clause |
| `golang.org/x/sys` | BSD-3-Clause |
| `golang.org/x/term` | BSD-3-Clause |
| `golang.org/x/text` | BSD-3-Clause |
| `golang.org/x/time` | BSD-3-Clause |
| `gvisor.dev/gvisor` | Apache-2.0 |
| `tailscale.com` | BSD-3-Clause |

### Required notices for Apache-2.0 components

```
AWS SDK for Go
Copyright 2015 Amazon.com, Inc. or its affiliates. All Rights Reserved.
Copyright 2014-2015 Stripe, Inc.

Smithy Go
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
```

(These modules are compiled in as dependencies of the Tailscale
library; NomadVNC does not talk to AWS.)

## Account server (`backend/`, not shipped in the apps)

Express (MIT), node-postgres `pg` (MIT), jsonwebtoken (MIT), Nodemailer
(MIT-0), and their dependencies — see `backend/package.json`.

---

To regenerate the Go table: `go list -deps ./cmd/nomadvnc-sidecar
./mobile` in `go-core/`, then read each module's license file.
