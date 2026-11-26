// הסמסטרון — menu bar app. Shows the next class (or how much there is to catch up on) next to
// the clock; clicking opens a panel with today's classes, lessons to catch up on (▶ recording),
// deadlines and Mincha/Maariv. Reads widget.json; refreshes every 5 minutes and on open.
import AppKit
import ServiceManagement
import SwiftUI
import WidgetKit

/// What the menu bar shows: "full" = icon + next class, "icon" = icon only, "text" = the text
/// without the icon (the icon comes back only when there's no text, so the item never vanishes),
/// "hidden" = nothing (widget only; ⚙️ in the widget or opening the app brings it back).
enum MenuBarMode: String, CaseIterable {
    case full, icon, text, hidden
    static let key = "menuBarMode"
    var label: String {
        switch self {
        case .full: return "סמל וטקסט"
        case .icon: return "סמל בלבד"
        case .text: return "טקסט בלבד"
        case .hidden: return "ללא"
        }
    }
}

@main
struct HasemestronApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate
    @StateObject private var model = Model()
    @AppStorage(MenuBarMode.key) private var mode = MenuBarMode.full.rawValue
    @AppStorage(HebrewDate.key) private var showHebrewDate = false
    @AppStorage("menuClass") private var showClass = true
    @AppStorage(Holiday.key) private var showHoliday = true

    var body: some Scene {
        MenuBarExtra(isInserted: Binding(
            get: { mode != MenuBarMode.hidden.rawValue },
            set: { if !$0 { mode = MenuBarMode.hidden.rawValue } } // ⌘-dragged out of the menu bar
        )) {
            Panel()
                .environmentObject(model)
                .environment(\.layoutDirection, .rightToLeft)
        } label: {
            let title = mode == MenuBarMode.icon.rawValue || !showClass ? "" : model.menuTitle
            let day = [showHoliday ? Holiday.emoji(model.now) : "", showHebrewDate ? HebrewDate.text(model.now) : ""]
                .filter { !$0.isEmpty }.joined(separator: " ")
            let text = [day, title].filter { !$0.isEmpty }.joined(separator: " · ")
            HStack(spacing: 4) {
                if mode != MenuBarMode.text.rawValue || text.isEmpty { Image(systemName: "graduationcap.fill") }
                if !text.isEmpty { Text(text) }
            }
        }
        .menuBarExtraStyle(.window)
    }
}

/// Optional (⚙️): today's Hebrew date next to the icon, e.g. "ל׳ בחשון" — macOS's own Hebrew
/// calendar and numerals; after sunset (Givat Ram) it already shows the next day.
enum HebrewDate {
    static let key = "hebrewDate"
    private static let lat = 31.7767, lon = 35.1981
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .hebrew)
        f.locale = Locale(identifier: "he_IL@numbers=hebr")
        f.timeZone = TimeZone(identifier: "Asia/Jerusalem")
        f.dateFormat = "d בMMMM"
        return f
    }()

    static func text(_ now: Date) -> String { formatter.string(from: day(now)) }

    /// a moment inside the current Hebrew day: after sunset that's already tomorrow
    static func day(_ now: Date) -> Date { now >= sunset(on: now) ? now.addingTimeInterval(86400) : now }

    /// Sunset that day (sunrise equation, about a minute off at most).
    static func sunset(on date: Date) -> Date {
        let rad = Double.pi / 180
        let n = (date.timeIntervalSince1970 / 86400 + 2440587.5 - 2451545.0 + 0.0008).rounded()
        let jStar = n - lon / 360
        let m = (357.5291 + 0.98560028 * jStar).truncatingRemainder(dividingBy: 360)
        let c = 1.9148 * sin(m * rad) + 0.02 * sin(2 * m * rad) + 0.0003 * sin(3 * m * rad)
        let l = (m + c + 180 + 102.9372).truncatingRemainder(dividingBy: 360)
        let transit = 2451545.0 + jStar + 0.0053 * sin(m * rad) - 0.0069 * sin(2 * l * rad)
        let decl = asin(sin(l * rad) * sin(23.4397 * rad))
        let h = acos((sin(-0.833 * rad) - sin(lat * rad) * sin(decl)) / (cos(lat * rad) * cos(decl))) / rad
        return Date(timeIntervalSince1970: (transit + h / 360 - 2440587.5) * 86400)
    }
}

/// Optional (⚙️, on by default): an emoji next to the icon on holidays and Rosh Chodesh, by the
/// Israeli calendar, switching at sunset like the Hebrew date (so Hanukkah's first candle shows
/// from the evening it's lit). Purim shows on both the 14th and Shushan Purim (Jerusalem).
enum Holiday {
    static let key = "holidayEmoji"
    private static let cal: Calendar = {
        var c = Calendar(identifier: .hebrew)
        c.timeZone = TimeZone(identifier: "Asia/Jerusalem")!
        return c
    }()

    static func emoji(_ now: Date) -> String {
        let d = HebrewDate.day(now)
        let c = cal.dateComponents([.year, .month, .day], from: d)
        guard let y = c.year, let m = c.month, let day = c.day else { return "" }
        var out: [String] = []
        if let e = holiday(y, m, day, d) { out.append(e) }
        // Rosh Chodesh: the 30th of a month and the 1st of the next (not Rosh Hashana)
        if day == 30 || (day == 1 && m != 1) { out.append("🌙") }
        return out.joined()
    }

    // months: 1 Tishrei … 3 Kislev, 4 Tevet, 5 Shevat, 6 Adar I (leap years), 7 Adar / Adar II,
    // 8 Nisan, 9 Iyar, 10 Sivan, 11 Tammuz, 12 Av, 13 Elul
    private static func holiday(_ y: Int, _ m: Int, _ day: Int, _ d: Date) -> String? {
        switch (m, day) {
        case (1, 1...2): return "🍎"           // Rosh Hashana
        case (1, 10): return "🕊️"              // Yom Kippur
        case (1, 15...21): return "🌿"         // Sukkot
        case (1, 22): return "📜"              // Shemini Atzeret / Simchat Torah
        case (5, 15): return "🌳"              // Tu BiShvat
        case (7, 14...15): return "🎭"         // Purim, Shushan Purim
        case (8, 15...21): return "🫓"         // Pesach
        case (9, 18): return "🔥"              // Lag BaOmer
        case (9, 28): return "🇮🇱"             // Yom Yerushalayim
        case (10, 6): return "🌾"              // Shavuot
        default: break
        }
        // Hanukkah: 8 days from 25 Kislev (Kislev has 29 or 30 days)
        if let start = date(y, 3, 25), (0...7).contains(days(from: start, to: d)) { return "🕯️" }
        // Yom HaAtzmaut: 5 Iyar, moved off Friday/Saturday to Thursday and off Monday to Tuesday
        if m == 9, let fifth = date(y, 9, 5) {
            let shift = [6: -1, 7: -2, 2: 1][cal.component(.weekday, from: fifth)] ?? 0
            if day == 5 + shift { return "🇮🇱" }
        }
        return nil
    }

    private static func date(_ y: Int, _ m: Int, _ day: Int) -> Date? {
        cal.date(from: DateComponents(year: y, month: m, day: day, hour: 12))
    }

    private static func days(from a: Date, to b: Date) -> Int {
        cal.dateComponents([.day], from: cal.startOfDay(for: a), to: cal.startOfDay(for: b)).day ?? -1
    }
}

/// hasemestron://show (the widget's ⚙️) or opening the app again → back in the menu bar;
/// hasemestron://open (tapping the widget) → the web app's own window.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if url.host == "open" { WebApp.open() } else { showInMenuBar() }
        }
    }

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
