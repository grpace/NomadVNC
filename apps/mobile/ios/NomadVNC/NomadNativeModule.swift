import Foundation
import Mobile
import React
import Security
import UIKit

/**
 * NomadNativeModule — React Native bridge to the embedded Go engine.
 *
 * The GoMobile framework (`Mobile.xcframework`, built via
 * `gomobile bind ./mobile` — see NATIVE_SETUP.md) owns the Tailscale
 * identity and the VNC session proxies in-process. This module:
 *
 * - configures the engine state dir on load,
 * - serves the viewer JS assets (viewer-runtime.js, viewer-bootstrap.mjs,
 *   viewer-input.mjs)
 *   over a loopback HTTP server so the WebView needs no custom URL
 *   scheme (http://127.0.0.1:* is already allowed by the viewer CSP),
 * - polls MobilePollEvents() while JS is observing and forwards engine
 *   events as "NomadNativeEvent",
 * - implements secure storage via the iOS Keychain and clipboard via
 *   UIPasteboard.
 */
@objc(NomadNativeModule)
class NomadNativeModule: RCTEventEmitter {

  // Dedicated queue for the event poll loop. pollLoop() sleeps between
  // iterations, so it stays off the bridge queue that serves method calls.
  private let pollQueue = DispatchQueue(label: "com.nomadvnc.poll", qos: .utility)
  private var webServer: GCDWebServer?
  private var assetBaseUrl: String?
  private var polling = false

  override init() {
    super.init()
    configureEngine()
    // GCDWebServer's +initialize aborts in debug builds unless it runs on
    // the main thread. The new architecture constructs this module off main.
    if Thread.isMainThread {
      startAssetServer()
    } else {
      DispatchQueue.main.sync {
        startAssetServer()
      }
    }
  }

  // MARK: - RCTEventEmitter

  override func supportedEvents() -> [String] {
    ["NomadNativeEvent"]
  }

  override static func requiresMainQueueSetup() -> Bool {
    false
  }

  override func startObserving() {
    polling = true
    pollQueue.async { [weak self] in self?.pollLoop() }
  }

  override func stopObserving() {
    polling = false
  }

  // MARK: - Engine

  private func configureEngine() {
    let fm = FileManager.default
    let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
      .appendingPathComponent("NomadVNC", isDirectory: true)
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    // UIDevice.name is "iPhone" without a special entitlement, which is
    // still a real device name. os.Hostname in the sandbox is localhost.
    MobileConfigure(dir.path, UIDevice.current.name)
  }

  /// The committed xcframework is the Objective-C gobind API: each call
  /// takes an NSError pointer instead of throwing.
  private func goString(_ invoke: (NSErrorPointer) -> String) throws -> String {
    var error: NSError?
    let value = invoke(&error)
    if let error {
      throw error
    }
    return value
  }

  private func pollLoop() {
    while polling {
      pollOnce()
      Thread.sleep(forTimeInterval: 0.5)
    }
  }

  private func pollOnce() {
    let raw = MobilePollEvents()
    guard let data = raw.data(using: .utf8),
          let events = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return
    }
    for var event in events {
      // Desktop's sidecarManager does the same mapping: Go emits
      // `statePayload`, the JS contract uses `state`.
      if (event["type"] as? String) == "tailnetState",
         event["state"] == nil,
         let payload = event["statePayload"] {
        event["state"] = payload
      }
      sendEvent(withName: "NomadNativeEvent", body: event)
    }
  }

  // MARK: - Viewer asset server

  private func startAssetServer() {
    guard let assets = Bundle.main.url(forResource: "ViewerAssets", withExtension: nil) else {
      return
    }
    let server = GCDWebServer()
    server.addHandler(
      forMethod: "GET",
      pathRegex: "^/(viewer-runtime\\.js|viewer-bootstrap\\.mjs|viewer-input\\.mjs)$",
      request: GCDWebServerRequest.self
    ) { request in
      let name = (request.path as NSString).lastPathComponent
      guard let fileURL = Optional(assets.appendingPathComponent(name)),
            let data = try? Data(contentsOf: fileURL) else {
        return GCDWebServerDataResponse(statusCode: 404)
      }
      let response = GCDWebServerDataResponse(data: data, contentType: "application/javascript")
      response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
      return response
    }
    do {
      try server.start(options: [
        GCDWebServerOption_Port: 0,
        GCDWebServerOption_BindToLocalhost: true,
        GCDWebServerOption_AutomaticallySuspendInBackground: false,
      ])
      webServer = server
      assetBaseUrl = "http://127.0.0.1:\(server.port)/"
    } catch {
      // getViewerAssetBaseUrl() will reject; the JS side surfaces it.
    }
  }

  // MARK: - Keychain

  private func keychainService() -> String {
    Bundle.main.bundleIdentifier ?? "com.nomadvnc.mobile"
  }

  private func keychainQuery(for key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService(),
      kSecAttrAccount as String: key,
    ]
  }

  private func keychainGet(_ key: String) -> String? {
    var query = keychainQuery(for: key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  private func keychainSet(_ key: String, value: String) throws {
    let data = Data(value.utf8)
    var query = keychainQuery(for: key)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    if SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess {
      let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
      if status != errSecSuccess { throw keychainError(status) }
    } else {
      query.merge(attributes) { _, new in new }
      let status = SecItemAdd(query as CFDictionary, nil)
      if status != errSecSuccess { throw keychainError(status) }
    }
  }

  private func keychainDelete(_ key: String) {
    SecItemDelete(keychainQuery(for: key) as CFDictionary)
  }

  private func keychainError(_ status: OSStatus) -> NSError {
    NSError(domain: "NomadKeychain", code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: "Keychain operation failed (\(status))"])
  }

  // MARK: - Exported methods

  @objc func ensureTailnetReady(_ resolve: @escaping RCTPromiseResolveBlock,
                                rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString(MobileEnsureTailnetReady))
    } catch {
      rejecter("E_TAILNET", error.localizedDescription, error)
    }
  }

  @objc func getTailnetPeers(_ resolve: @escaping RCTPromiseResolveBlock,
                             rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString(MobileGetTailnetPeers))
    } catch {
      rejecter("E_TAILNET", error.localizedDescription, error)
    }
  }

  @objc func getTailnetState(_ resolve: @escaping RCTPromiseResolveBlock,
                             rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString(MobileGetTailnetState))
    } catch {
      rejecter("E_TAILNET", error.localizedDescription, error)
    }
  }

  @objc func getPeerPath(_ host: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString { MobileGetPeerPath(host, $0) })
    } catch {
      rejecter("E_PEERPATH", error.localizedDescription, error)
    }
  }

  @objc func startVncSession(_ host: String,
                             port: NSNumber,
                             token: String,
                             direct: Bool,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString { MobileStartVncSession(host, port.intValue, token, direct, $0) })
    } catch {
      rejecter("E_SESSION", error.localizedDescription, error)
    }
  }

  @objc func stopVncSession(_ sessionId: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter: @escaping RCTPromiseRejectBlock) {
    var error: NSError?
    _ = MobileStopVncSession(sessionId, &error)
    if let error {
      rejecter("E_SESSION", error.localizedDescription, error)
      return
    }
    resolve(nil)
  }

  @objc func logoutTailnet(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString(MobileLogoutTailnet))
    } catch {
      rejecter("E_TAILNET", error.localizedDescription, error)
    }
  }

  @objc func reauthenticateTailnet(_ resolve: @escaping RCTPromiseResolveBlock,
                                   rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString(MobileReauthenticateTailnet))
    } catch {
      rejecter("E_TAILNET", error.localizedDescription, error)
    }
  }

  @objc func setTailscaleHostname(_ hostname: String,
                                  resolver resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString { MobileSetTailscaleHostname(hostname, $0) })
    } catch {
      reject("E_TAILNET", error.localizedDescription, error)
    }
  }

  @objc func resetTailnetIdentity(_ resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      resolve(try goString(MobileResetTailnetIdentity))
    } catch {
      rejecter("E_TAILNET", error.localizedDescription, error)
    }
  }

  /// Latest nomadvnc:// URL the scene received, if JavaScript has not read it yet.
  @objc func takePendingAuthURL(_ resolve: @escaping RCTPromiseResolveBlock,
                                rejecter _: @escaping RCTPromiseRejectBlock) {
    resolve(AppDelegate.takeAuthURL())
  }

  @objc func getSecureItem(_ key: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter: @escaping RCTPromiseRejectBlock) {
    resolve(keychainGet(key))
  }

  @objc func setSecureItem(_ key: String,
                           value: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter: @escaping RCTPromiseRejectBlock) {
    do {
      try keychainSet(key, value: value)
      resolve(nil)
    } catch {
      rejecter("E_KEYCHAIN", error.localizedDescription, error)
    }
  }

  @objc func deleteSecureItem(_ key: String,
                              resolver resolve: @escaping RCTPromiseResolveBlock,
                              rejecter: @escaping RCTPromiseRejectBlock) {
    keychainDelete(key)
    resolve(nil)
  }

  @objc func getSecureStorageStatus(_ resolve: @escaping RCTPromiseResolveBlock,
                                    rejecter: @escaping RCTPromiseRejectBlock) {
    let status: [String: Any] = [
      "available": true,
      "platform": "ios",
      "backend": "keychain",
    ]
    if let data = try? JSONSerialization.data(withJSONObject: status),
       let json = String(data: data, encoding: .utf8) {
      resolve(json)
    } else {
      rejecter("E_STORAGE", "Could not encode secure storage status", nil)
    }
  }

  @objc func readClipboard(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      resolve(UIPasteboard.general.string ?? "")
    }
  }

  /// Changes whenever the pasteboard does, without reading its contents,
  /// so polling it never triggers the iOS paste prompt. "" when there's
  /// no text.
  @objc func getClipboardChangeToken(_ resolve: @escaping RCTPromiseResolveBlock,
                                     rejecter: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let pasteboard = UIPasteboard.general
      resolve(pasteboard.hasStrings ? String(pasteboard.changeCount) : "")
    }
  }

  @objc func writeClipboard(_ text: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      UIPasteboard.general.string = text
      resolve(nil)
    }
  }

  @objc func getAppVersion(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter: @escaping RCTPromiseRejectBlock) {
    resolve(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0")
  }

  @objc func getViewerAssetBaseUrl(_ resolve: @escaping RCTPromiseResolveBlock,
                                    rejecter: @escaping RCTPromiseRejectBlock) {
    if let base = assetBaseUrl {
      resolve(base)
    } else {
      rejecter("E_ASSETS", "Viewer asset server is not running", nil)
    }
  }

  @objc func storageGetItem(_ key: String,
                            resolver: @escaping RCTPromiseResolveBlock,
                            rejecter: @escaping RCTPromiseRejectBlock) {
    resolver(UserDefaults.standard.string(forKey: key))
  }

  @objc func storageSetItem(_ key: String,
                            value: String,
                            resolver: @escaping RCTPromiseResolveBlock,
                            rejecter: @escaping RCTPromiseRejectBlock) {
    UserDefaults.standard.set(value, forKey: key)
    resolver(nil)
  }

  @objc func storageRemoveItem(_ key: String,
                               resolver: @escaping RCTPromiseResolveBlock,
                               rejecter: @escaping RCTPromiseRejectBlock) {
    UserDefaults.standard.removeObject(forKey: key)
    resolver(nil)
  }
}