// הסמסטרון — menu bar app. Shows the next class (or how much there is to catch up on) next to
// the clock; clicking opens a panel with today's classes, lessons to catch up on (▶ recording),
// deadlines and Mincha/Maariv. Reads widget.json; refreshes every 5 minutes and on open.
import AppKit
import ServiceManagement
import SwiftUI
import WidgetKit

/// What the menu bar shows: "full" = icon + next class, "icon" = icon only,
/// "hidden" = nothing (widget only; ⚙️ in the widget or opening the app brings it back).
enum MenuBarMode: String, CaseIterable {
    case full, icon, hidden
    static let key = "menuBarMode"
    var label: String {
        switch self {
        case .full: return "סמל וטקסט"
        case .icon: return "סמל בלבד"
        case .hidden: return "ללא (וידג׳ט בלבד)"
        }
    }
}

@main
struct HasemestronApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate
    @StateObject private var model = Model()
    @AppStorage(MenuBarMode.key) private var mode = MenuBarMode.full.rawValue

    var body: some Scene {
        MenuBarExtra(isInserted: Binding(
            get: { mode != MenuBarMode.hidden.rawValue },
            set: { if !$0 { mode = MenuBarMode.hidden.rawValue } } // ⌘-dragged out of the menu bar
        )) {
            Panel()
                .environmentObject(model)
                .environment(\.layoutDirection, .rightToLeft)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "graduationcap.fill")
                if mode == MenuBarMode.full.rawValue, !model.menuTitle.isEmpty { Text(model.menuTitle) }
            }
        }
        .menuBarExtraStyle(.window)
    }
}

/// hasemestron://show (the widget's ⚙️) or opening the app again → back in the menu bar.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) { showInMenuBar() }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showInMenuBar()
        return false
    }

    private func showInMenuBar() {
        if UserDefaults.standard.string(forKey: MenuBarMode.key) == MenuBarMode.hidden.rawValue {
            UserDefaults.standard.set(MenuBarMode.full.rawValue, forKey: MenuBarMode.key)
        }
    }
}

@MainActor
final class Model: ObservableObject {
    @Published var summary: Summary?
    @Published var now = Date()
    @Published var error: String?
    @Published var loading = false
    @Published var doneHere: Set<String> = [] // checked off here, until the next fetch confirms
    @Published var lastFetch: Date?
    @Published var hasToken = Keychain.token != nil

    private var tick: Timer?

    init() {
        if let cached = UserDefaults.standard.data(forKey: "summary"), let s = try? Feed.decode(cached) { summary = s }
        tick = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.now = Date()
                // widget-only mode: nothing here to keep fresh (the widget fetches by itself)
                let hidden = UserDefaults.standard.string(forKey: MenuBarMode.key) == MenuBarMode.hidden.rawValue
                if !hidden, (self.lastFetch.map { Date().timeIntervalSince($0) > 300 } ?? true) { await self.refresh() }
            }
        }
        // re-register after a reinstall, so login launches the current copy
        if UserDefaults.standard.bool(forKey: "launchAtLogin") { try? SMAppService.mainApp.register() }
        Task { await refresh() }
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            let (s, data) = try await Feed.fetch()
            summary = s
            doneHere = []
            error = nil
            lastFetch = Date()
            UserDefaults.standard.set(data, forKey: "summary")
        } catch {
            self.error = summary == nil ? "אין חיבור לנתונים" : "לא מעודכן — אין חיבור"
        }
        now = Date()
    }

    func markDone(_ key: String) async {
        guard let token = Keychain.token else { return }
        doneHere.insert(key)
        do {
            try await GitHub.markDone([key], token: token)
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            doneHere.remove(key)
            self.error = error.localizedDescription
        }
    }

    func setToken(_ token: String?) {
        Keychain.save(token?.trimmingCharacters(in: .whitespacesAndNewlines))
        hasToken = Keychain.token != nil
    }

    /// next to the clock: the running class, else today's next one, else what's waiting
    var menuTitle: String {
        guard let s = summary else { return "" }
        if let c = s.current(now) { return "\(c.short) עד \(Fmt.time(c.end))" }
        if let n = s.comingSessions(now).first, Calendar.current.isDateInToday(n.start) {
            return "\(n.short) \(Fmt.time(n.start))"
        }
        let owed = s.toCatchUp(now, done: doneHere).count
        return owed > 0 ? "\(owed) להשלים" : ""
    }

    // ---------- launch at login ----------
    var launchAtLogin: Bool { SMAppService.mainApp.status == .enabled }

    func setLaunchAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            UserDefaults.standard.set(on, forKey: "launchAtLogin")
        } catch {
            self.error = "הפעלה בכניסה: \(error.localizedDescription)"
        }
        objectWillChange.send()
    }
}
