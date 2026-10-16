// הסמסטרון — menu bar app. Shows the next class (or how much there is to catch up on) next to
// the clock; clicking opens a panel with today's classes, lessons to catch up on (▶ recording),
// deadlines and Mincha/Maariv. Reads widget.json; refreshes every 5 minutes and on open.
import AppKit
import ServiceManagement
import SwiftUI
import WidgetKit

@main
struct HasemestronApp: App {
    @StateObject private var model = Model()

    var body: some Scene {
        MenuBarExtra {
            Panel()
                .environmentObject(model)
                .environment(\.layoutDirection, .rightToLeft)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "graduationcap.fill")
                Text(model.menuTitle)
            }
        }
        .menuBarExtraStyle(.window)
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
                if (self.lastFetch.map { Date().timeIntervalSince($0) > 300 } ?? true) { await self.refresh() }
            }
        }
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
        } catch {
            self.error = "הפעלה בכניסה: \(error.localizedDescription)"
        }
        objectWillChange.send()
    }
}
