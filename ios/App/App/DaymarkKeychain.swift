import Foundation
import Security
import Capacitor

@objc(DaymarkKeychainPlugin)
public class DaymarkKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DaymarkKeychainPlugin"
    public let jsName = "DaymarkKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keys", returnType: CAPPluginReturnPromise)
    ]
    private let service = "com.dylanxzthomas.wren.daymark.auth"
    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }
    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("Missing key"); return }
        var q = query(key); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve([:]); return }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { call.reject("Secure session unavailable"); return }
        call.resolve(["value": value])
    }
    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else { call.reject("Missing session value"); return }
        let q = query(key)
        let attrs: [String: Any] = [kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(q.merging(attrs) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { call.reject("Could not save secure session"); return }
        call.resolve()
    }
    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("Missing key"); return }
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { call.reject("Could not remove session"); return }
        call.resolve()
    }
    @objc func keys(_ call: CAPPluginCall) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve(["keys": [String]()]); return }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { call.reject("Secure session unavailable"); return }
        call.resolve(["keys": items.compactMap { $0[kSecAttrAccount as String] as? String }])
    }
}

class DaymarkViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DaymarkKeychainPlugin())
        bridge?.registerPluginInstance(DaymarkIntakePlugin())
        bridge?.registerPluginInstance(DaymarkCalendarPlugin())
        let background = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 17/255, green: 19/255, blue: 16/255, alpha: 1)
                : UIColor(red: 247/255, green: 247/255, blue: 243/255, alpha: 1)
        }
        view.backgroundColor = background
        webView?.isOpaque = false
        webView?.backgroundColor = background
        webView?.scrollView.backgroundColor = background
    }
}

@objc(DaymarkIntakePlugin)
public class DaymarkIntakePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DaymarkIntakePlugin"
    public let jsName = "DaymarkIntake"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "pending", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise)]
    private func root() -> URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.dylanxzthomas.wren.daymark")?.appendingPathComponent("DaymarkOutbox", isDirectory: true) }
    @objc func pending(_ call: CAPPluginCall) {
        guard let root = root(), let folders = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { call.resolve(["notices": []]); return }
        var notices: [[String: Any]] = []
        // One durable handoff at a time. Ignore directories still being written by the extension.
        for folder in folders.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where UUID(uuidString: folder.lastPathComponent) != nil {
            guard let data = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")), var item = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            var files: [[String: String]] = []
            for file in item["files"] as? [[String: String]] ?? [] {
                guard let name = file["name"], !name.contains("/"), let bytes = try? Data(contentsOf: folder.appendingPathComponent(name)) else { call.reject("A shared file is missing. Share the notice again."); return }
                files.append(["name": name, "type": file["type"] ?? "application/octet-stream", "base64": bytes.base64EncodedString()])
            }
            item["files"] = files; notices.append(item); break
        }
        call.resolve(["notices": notices])
    }
    @objc func acknowledge(_ call: CAPPluginCall) {
        guard let root = root(), let id = call.getString("id"), UUID(uuidString: id) != nil else { call.reject("Invalid shared notice"); return }
        do { try FileManager.default.removeItem(at: root.appendingPathComponent(id)); call.resolve() } catch { call.reject("Shared notice remains on this phone") }
    }
}
