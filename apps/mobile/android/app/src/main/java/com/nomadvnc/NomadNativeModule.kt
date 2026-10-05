package com.nomadvnc

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.SharedPreferences
import android.content.res.AssetManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import mobile.Mobile
import org.json.JSONArray
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * NomadNativeModule — React Native bridge to the embedded Go engine.
 *
 * The GoMobile AAR (`mobile.aar`, built via `gomobile bind ./mobile` — see
 * NATIVE_SETUP.md) owns the Tailscale identity and the VNC session proxies
 * in-process. This module:
 *
 * - configures the engine state dir on load,
 * - serves the viewer JS assets (viewer-runtime.js, viewer-bootstrap.mjs,
 *   viewer-input.mjs)
 *   from `assets/viewer/` over a loopback HTTP server so the WebView needs
 *   no custom URL scheme (http://127.0.0.1:* is already allowed by the
 *   viewer CSP),
 * - polls Mobile.pollEvents() every 500ms and forwards engine events as
 *   "NomadNativeEvent",
 * - implements secure storage via EncryptedSharedPreferences (Keystore)
 *   and clipboard via ClipboardManager.
 */
class NomadNativeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val assetServer = AssetServer(reactContext.assets)
    private val pollHandler = Handler(Looper.getMainLooper())
    // Dedicated executor for Go engine calls. GoMobile calls like
    // ensureTailnetReady() can block for up to 60s (waiting for tsnet
    // login to settle); running them on the RN bridge thread would
    // stall all other bridge calls and risk ANRs.
    private val goExecutor = Executors.newCachedThreadPool { r ->
        Thread(r, "nomadvnc-go").apply { isDaemon = true }
    }

    // Defined here (not below with the other polling code) so
    // onCatalystInstanceDestroy() can reference it — Kotlin initializes
    // member properties in declaration order.
    private val pollRunnable = object : Runnable {
        override fun run() {
            try {
                val events = JSONArray(Mobile.pollEvents())
                for (i in 0 until events.length()) {
                    val event = events.getJSONObject(i)
                    // Desktop's sidecarManager does the same mapping: Go emits
                    // `statePayload`, the JS contract uses `state`.
                    if (event.optString("type") == "tailnetState" &&
                        !event.has("state") && event.has("statePayload")) {
                        event.put("state", event.get("statePayload"))
                    }
                    emit(event)
                }
            } catch (_: Exception) {
                // Polling must never die; the next tick retries.
            }
            pollHandler.postDelayed(this, 500)
        }
    }

    private val securePrefs: SharedPreferences by lazy {
        EncryptedSharedPreferences.create(
            reactContext,
            "nomadvnc_secure",
            MasterKey.Builder(reactContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    init {
        try {
            val dir = File(reactContext.filesDir, "nomadvnc-state").apply { mkdirs() }
            Mobile.configure(dir.absolutePath, suggestedDeviceName())
        } catch (e: Exception) {
            // Engine configuration failed; the JS side surfaces errors per-call.
            // Module must still construct so the app can show an error state.
            android.util.Log.e("NomadNativeModule", "Failed to configure engine", e)
        }
        try {
            assetServer.start()
        } catch (e: Exception) {
            android.util.Log.e("NomadNativeModule", "Failed to start asset server", e)
        }
        pollHandler.post(pollRunnable)
    }

    override fun getName() = "NomadNativeModule"

    override fun onCatalystInstanceDestroy() {
        // Stop event polling and shut down the Go executor. The poll
        // runnable otherwise keeps the main looper busy forever, and the
        // cached thread pool would leak threads across bridge reloads.
        try {
            pollHandler.removeCallbacks(pollRunnable)
        } catch (_: Exception) {
        }
        try {
            goExecutor.shutdownNow()
        } catch (_: Exception) {
        }
        try {
            assetServer.stop()
        } catch (_: Exception) {
        }
        super.onCatalystInstanceDestroy()
    }

    // MARK: - Engine

    @ReactMethod
    fun ensureTailnetReady(promise: Promise) {
        runGo(promise) { Mobile.ensureTailnetReady() }
    }

    @ReactMethod
    fun getTailnetPeers(promise: Promise) {
        runGo(promise) { Mobile.getTailnetPeers() }
    }

    @ReactMethod
    fun getTailnetState(promise: Promise) {
        runGo(promise) { Mobile.getTailnetState() }
    }

    @ReactMethod
    fun getPeerPath(host: String, promise: Promise) {
        runGo(promise) { Mobile.getPeerPath(host) }
    }

    @ReactMethod
    fun startVncSession(host: String, port: Double, token: String, direct: Boolean, promise: Promise) {
        runGo(promise) { Mobile.startVncSession(host, port.toLong(), token, direct) }
    }

    @ReactMethod
    fun stopVncSession(sessionId: String, promise: Promise) {
        runGo(promise) {
            Mobile.stopVncSession(sessionId)
            "ok"
        }
    }

    @ReactMethod
    fun logoutTailnet(promise: Promise) {
        runGo(promise) { Mobile.logoutTailnet() }
    }

    @ReactMethod
    fun reauthenticateTailnet(promise: Promise) {
        runGo(promise) { Mobile.reauthenticateTailnet() }
    }

    @ReactMethod
    fun resetTailnetIdentity(promise: Promise) {
        runGo(promise) { Mobile.resetTailnetIdentity() }
    }

    @ReactMethod
    fun setTailscaleHostname(hostname: String, promise: Promise) {
        runGo(promise) { Mobile.setTailscaleHostname(hostname) }
    }

    private fun suggestedDeviceName(): String {
        val named = android.provider.Settings.Global.getString(reactContext.contentResolver, "device_name")
        if (!named.isNullOrBlank()) return named
        return android.os.Build.MODEL ?: ""
    }

    private inline fun runGo(promise: Promise, crossinline block: () -> String) {
        goExecutor.execute {
            try {
                val result = block()
                // Resolve on the original thread to keep promise semantics
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("E_GO", e.message, e)
            }
        }
    }

    // MARK: - Event polling

    // Required by NativeEventEmitter on Android (iOS gets these from
    // RCTEventEmitter). Events are polled for the module's whole lifetime
    // (started in init), so listener counts don't matter: no-ops.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Double) {}

    private fun emit(event: org.json.JSONObject) {
        val map = Arguments.createMap()
        val keys = event.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            when (val value = event.opt(key)) {
                is String -> map.putString(key, value)
                is Boolean -> map.putBoolean(key, value)
                is Int -> map.putInt(key, value)
                is Long -> map.putDouble(key, value.toDouble())
                is Double -> map.putDouble(key, value)
                is org.json.JSONObject -> map.putMap(key, jsonToMap(value))
                is JSONArray -> map.putArray(key, jsonToArray(value))
                else -> map.putNull(key)
            }
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("NomadNativeEvent", map)
    }

    private fun jsonToMap(obj: org.json.JSONObject): com.facebook.react.bridge.WritableMap {
        val map = Arguments.createMap()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            when (val value = obj.opt(key)) {
                is String -> map.putString(key, value)
                is Boolean -> map.putBoolean(key, value)
                is Int -> map.putInt(key, value)
                is Double -> map.putDouble(key, value)
                else -> map.putNull(key)
            }
        }
        return map
    }

    private fun jsonToArray(arr: JSONArray): com.facebook.react.bridge.WritableArray {
        val out = Arguments.createArray()
        for (i in 0 until arr.length()) {
            when (val value = arr.opt(i)) {
                is String -> out.pushString(value)
                is Boolean -> out.pushBoolean(value)
                is Int -> out.pushInt(value)
                is Double -> out.pushDouble(value)
                else -> out.pushNull()
            }
        }
        return out
    }

    // MARK: - Secure storage (Keystore-backed)

    @ReactMethod
    fun getSecureItem(key: String, promise: Promise) {
        try {
            promise.resolve(securePrefs.getString(key, null))
        } catch (e: Exception) {
            promise.reject("E_STORAGE", e.message, e)
        }
    }

    @ReactMethod
    fun setSecureItem(key: String, value: String, promise: Promise) {
        try {
            securePrefs.edit().putString(key, value).apply()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_STORAGE", e.message, e)
        }
    }

    @ReactMethod
    fun deleteSecureItem(key: String, promise: Promise) {
        try {
            securePrefs.edit().remove(key).apply()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_STORAGE", e.message, e)
        }
    }

    @ReactMethod
    fun getSecureStorageStatus(promise: Promise) {
        promise.resolve(
            """{"available":true,"platform":"android","backend":"encrypted-shared-preferences"}""",
        )
    }

    // MARK: - Clipboard

    @ReactMethod
    fun readClipboard(promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            promise.resolve(cm.primaryClip?.getItemAt(0)?.coerceToText(reactContext)?.toString() ?: "")
        } catch (e: Exception) {
            promise.reject("E_CLIPBOARD", e.message, e)
        }
    }

    /**
     * Changes whenever the clipboard does, without reading its contents
     * (only the description), so polling it never shows Android's
     * "pasted from your clipboard" toast. "" when there's no text.
     */
    @ReactMethod
    fun getClipboardChangeToken(promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val description = cm.primaryClipDescription
            val hasText = description != null &&
                (description.hasMimeType("text/*") || description.hasMimeType("text/plain"))
            val token = when {
                !hasText -> ""
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> "t${description!!.timestamp}"
                else -> "h${System.identityHashCode(description)}"
            }
            promise.resolve(token)
        } catch (e: Exception) {
            promise.reject("E_CLIPBOARD", e.message, e)
        }
    }

    @ReactMethod
    fun writeClipboard(text: String, promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("NomadVNC", text))
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_CLIPBOARD", e.message, e)
        }
    }

    // MARK: - Misc

    @ReactMethod
    fun getAppVersion(promise: Promise) {
        val version = try {
            reactContext.packageManager.getPackageInfo(reactContext.packageName, 0).versionName
        } catch (_: Exception) {
            null
        }
        promise.resolve(version ?: "0.0.0")
    }

    @ReactMethod
    fun getViewerAssetBaseUrl(promise: Promise) {
        val base = assetServer.baseUrl()
        if (base != null) promise.resolve(base)
        else promise.reject("E_ASSETS", "Viewer asset server is not running")
    }

    // MARK: - Loopback viewer-asset server

    /**
     * Minimal single-purpose HTTP server on 127.0.0.1 serving the three
     * viewer JS files from assets/viewer/. Only GET, only the known
     * paths; everything else 404s. Served with
     * `Access-Control-Allow-Origin: *` so the WebView can load the
     * bootstrap as a module script.
     */
    private class AssetServer(private val assets: AssetManager) {
        private var socket: ServerSocket? = null

        fun baseUrl(): String? {
            val port = socket?.localPort?.takeIf { it > 0 } ?: return null
            return "http://127.0.0.1:$port/"
        }

        fun start() {
            val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
            socket = server
            thread(isDaemon = true, name = "nomadvnc-assets") {
                while (!server.isClosed) {
                    try {
                        val client = server.accept()
                        thread(isDaemon = true) { handle(client) }
                    } catch (_: Exception) {
                        break
                    }
                }
            }
        }

        fun stop() {
            try {
                socket?.close()
            } catch (_: Exception) {
            }
            socket = null
        }

        private fun handle(client: Socket) {
            client.use {
                try {
                    // A client that connects and never sends a request line
                    // must not pin this thread forever.
                    it.soTimeout = 5_000
                    val reader = it.getInputStream().bufferedReader()
                    val requestLine = reader.readLine() ?: return
                    var line: String?
                    do {
                        line = reader.readLine()
                    } while (line != null && line.isNotEmpty())
                    val assetPath = when (requestLine.split(" ").getOrNull(1)) {
                        "/viewer-runtime.js" -> "viewer/viewer-runtime.js"
                        "/viewer-bootstrap.mjs" -> "viewer/viewer-bootstrap.mjs"
                        "/viewer-input.mjs" -> "viewer/viewer-input.mjs"
                        else -> null
                    }
                    val out = it.getOutputStream()
                    if (assetPath == null) {
                        out.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".toByteArray())
                        return
                    }
                    val bytes = try {
                        assets.open(assetPath).readBytes()
                    } catch (e: Exception) {
                        out.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".toByteArray())
                        return
                    }
                    out.write(
                        ("HTTP/1.1 200 OK\r\n" +
                            "Content-Type: application/javascript\r\n" +
                            "Content-Length: ${bytes.size}\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Connection: close\r\n\r\n").toByteArray(),
                    )
                    out.write(bytes)
                    out.flush()
                } catch (_: Exception) {
                    // Client disconnected or I/O error; nothing to do.
                }
            }
        }
    }

    @ReactMethod
    fun storageGetItem(key: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("nomadvnc.prefs", 0)
            promise.resolve(prefs.getString(key, null))
        } catch (e: Exception) {
            promise.reject("STORAGE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun storageSetItem(key: String, value: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("nomadvnc.prefs", 0)
            prefs.edit().putString(key, value).apply()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STORAGE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun storageRemoveItem(key: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("nomadvnc.prefs", 0)
            prefs.edit().remove(key).apply()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STORAGE_ERROR", e.message)
        }
    }
}