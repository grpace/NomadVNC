import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

#if DEBUG && !targetEnvironment(simulator)
// Linked from React's dev support. Declared here so the device build can
// turn the banner off without a bridging header.
@_silgen_name("RCTDevLoadingViewSetEnabled")
func RCTDevLoadingViewSetEnabled(_ enabled: Bool)
#endif

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?

  // The scene can receive nomadvnc:// before JavaScript is listening.
  // JS reads this when it starts and again whenever the app becomes active.
  private static let authURLLock = NSLock()
  private static var pendingAuthURL: String?

  static func storeAuthURL(_ url: URL) {
    guard url.scheme?.lowercased() == "nomadvnc" else { return }
    authURLLock.lock()
    pendingAuthURL = url.absoluteString
    authURLLock.unlock()
  }

  static func takeAuthURL() -> String? {
    authURLLock.lock()
    let value = pendingAuthURL
    pendingAuthURL = nil
    authURLLock.unlock()
    return value
  }

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
#if DEBUG && !targetEnvironment(simulator)
    // The debug loading view says "Connect to Metro to develop JavaScript"
    // in its own window. On a phone that window covers the app, then leaves
    // the screen black after the message hides.
    RCTDevLoadingViewSetEnabled(false)
#endif
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    self.launchOptions = launchOptions

    return true
  }

  // Used when a scene is not yet connected. SceneDelegate handles the
  // same nomadvnc:// link once the scene exists.
  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    Self.storeAuthURL(url)
    return RCTLinkingManager.application(app, open: url, options: options)
  }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    var launchOptions = appDelegate.launchOptions ?? [:]
    if let url = connectionOptions.urlContexts.first?.url {
      AppDelegate.storeAuthURL(url)
      launchOptions[.url] = url
    }

    factory.startReactNative(
      withModuleName: "NomadVNC",
      in: window,
      launchOptions: launchOptions
    )
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      AppDelegate.storeAuthURL(context.url)
      _ = RCTLinkingManager.application(UIApplication.shared, open: context.url, options: [:])
    }
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG && targetEnvironment(simulator)
    // The simulator loads from Metro so reload stays available.
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    // Device builds already embed main.jsbundle. Waiting on Metro leaves a
    // black screen when the phone cannot reach the Mac.
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
