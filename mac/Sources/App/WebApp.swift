// Opens הסמסטרון in its own window — the web app as installed by Chrome ("Install app"), which
// lives in ~/Applications/Chrome Apps.localized/ — instead of a browser tab. Found by its
// start address (CrAppModeShortcutURL in the app's Info.plist); falls back to the browser.
import AppKit

enum WebApp {
    static func open(query: String = "") {
        guard let app = installedApp() else {
            if let url = URL(string: Config.appURL + query) { NSWorkspace.shared.open(url) }
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        if !query.isEmpty, let url = URL(string: Config.appURL + query) {
            // a deep link (e.g. ?inbox=1) handed to the app window; plain launch if it refuses
            NSWorkspace.shared.open([url], withApplicationAt: app, configuration: config) { _, error in
                if error != nil { NSWorkspace.shared.openApplication(at: app, configuration: config) }
            }
        } else {
            NSWorkspace.shared.openApplication(at: app, configuration: config)
        }
    }

    private static func installedApp() -> URL? {
        let fm = FileManager.default
        let dirs = [fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Chrome Apps.localized"),
                    URL(fileURLWithPath: "/Applications/Chrome Apps.localized")]
        for dir in dirs {
            let apps = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for app in apps where app.pathExtension == "app" {
                let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
                if let start = info?["CrAppModeShortcutURL"] as? String, start.hasPrefix(Config.appURL) { return app }
            }
        }
        return nil
    }
}
