// "✓" from the menu bar: writes the same progress entry the web app writes
// (progress[key] = { s: "done", t: ms }) into the sync gist, and updates widget.json so the
// widget drops the item at once. Needs the gist token (the same one pasted in the web app),
// kept in the macOS Keychain.
import Foundation
import Security

enum GitHub {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func markDone(_ keys: [String], token: String) async throws {
        let gist = try await request("GET", token: token)
        guard let files = gist["files"] as? [String: Any],
              let progressFile = files["progress.json"] as? [String: Any] else {
            throw Failure(message: "progress.json לא נמצא בגיסט")
        }
        var progressText = progressFile["content"] as? String ?? "{}"
        if progressFile["truncated"] as? Bool == true, let raw = progressFile["raw_url"] as? String, let url = URL(string: raw) {
            var req = URLRequest(url: url)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            progressText = String(decoding: try await URLSession.shared.data(for: req).0, as: UTF8.self)
        }
        var progress = (try? JSONSerialization.jsonObject(with: Data(progressText.utf8))) as? [String: Any] ?? [:]
        let t = Int(Date().timeIntervalSince1970 * 1000)
        for key in keys { progress[key] = ["s": "done", "t": t] }

        var out: [String: Any] = ["progress.json": ["content": try json(progress)]]
        if let widgetFile = files["widget.json"] as? [String: Any], let text = widgetFile["content"] as? String,
           var widget = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
            let set = Set(keys)
            for list in ["catchUp", "tasks"] {
                widget[list] = (widget[list] as? [[String: Any]] ?? []).filter { !set.contains($0["key"] as? String ?? "") }
            }
            for list in ["sessions", "prayers"] {
                widget[list] = (widget[list] as? [[String: Any]] ?? []).map { item in
                    var item = item
                    if set.contains(item["key"] as? String ?? "") { item["done"] = true }
                    return item
                }
            }
            out["widget.json"] = ["content": try json(widget)]
        }
        _ = try await request("PATCH", token: token, body: ["files": out])
    }

    private static func json(_ obj: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self)
    }

    private static func request(_ method: String, token: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: "https://api.github.com/gists/\(Config.gistID)")!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, res) = try await URLSession.shared.data(for: req)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            throw Failure(message: code == 401 || code == 403 || code == 404 ? "הטוקן לא מתאים (GitHub \(code))" : "GitHub \(code)")
        }
        return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

enum Keychain {
    private static let service = "io.github.akivamprager.semestron"
    private static let account = "gist-token"

    static var token: String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    static func save(_ token: String?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        guard let token, !token.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(token.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}
