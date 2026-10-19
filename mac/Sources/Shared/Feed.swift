// The summary written by the web app / the GitHub job (widget.js → widget.json in the sync
// gist). The Mac app and the widget only read it and filter by the clock.
import Foundation
import SwiftUI

struct Summary: Codable {
    var v: Int
    var semester: String
    var sessions: [Session]
    var catchUp: [CatchUp]
    var tasks: [TaskItem]
    var prayers: [Prayer]
    var inbox: Int
    var generatedAt: Date?
}

struct Session: Codable, Identifiable {
    var course, short, emoji, color, key, label, topic: String
    var start, end: Date
    var room, lecturer: String
    var done: Bool
    var id: String { key }
    /// "🌊 גלים · הרצאה 3", or just "📖 חברותא עם אוהד" for a personal commitment (no label)
    var title: String { label.isEmpty ? "\(emoji) \(short)" : "\(emoji) \(short) · \(label)" }
}

struct CatchUp: Codable, Identifiable {
    var course, short, emoji, color, key, label, topic: String
    var availableAt: Date
    var recording: String?
    var id: String { key }
}

struct TaskItem: Codable, Identifiable {
    var course, short, emoji, color, key, title, kind: String
    var due: Date
    var id: String { key }
}

struct Prayer: Codable, Identifiable {
    var key, prayer, label: String
    var start: Date
    var place: String
    var approx, done: Bool
    var id: String { key }
}

enum Feed {
    static let url = URL(string: Config.rawBase + "widget.json")!

    static func fetch() async throws -> (Summary, Data) {
        // a unique query string skips GitHub's CDN copy (up to ~5 minutes old)
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "t", value: String(Int(Date().timeIntervalSince1970)))]
        var req = URLRequest(url: comps.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let (data, res) = try await URLSession.shared.data(for: req)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return (try decode(data), data)
    }

    static func decode(_ data: Data) throws -> Summary {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let s = try dec.singleValueContainer().decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = f.date(from: s) { return date }
            f.formatOptions = [.withInternetDateTime]
            if let date = f.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: s))
        }
        return try d.decode(Summary.self, from: data)
    }
}

// What to show at a given moment. `done` = keys checked off here since the last fetch.
extension Summary {
    func toCatchUp(_ now: Date, done: Set<String> = []) -> [CatchUp] {
        catchUp.filter { $0.availableAt <= now && !done.contains($0.key) }
    }
    /// sessions not over yet (the first one may be running now)
    func comingSessions(_ now: Date) -> [Session] {
        sessions.filter { $0.end > now }
    }
    func current(_ now: Date) -> Session? {
        sessions.first { $0.start <= now && now < $0.end }
    }
    func openTasks(_ done: Set<String> = []) -> [TaskItem] {
        tasks.filter { !done.contains($0.key) }
    }
    func todaysPrayers(_ now: Date, done: Set<String> = []) -> [Prayer] {
        prayers.filter { Calendar.current.isDate($0.start, inSameDayAs: now) && !$0.done && !done.contains($0.key)
            && $0.start.addingTimeInterval(30 * 60) > now }
    }
    /// moments when the picture changes by itself (for widget timelines)
    func changePoints(after now: Date, within hours: Double) -> [Date] {
        let limit = now.addingTimeInterval(hours * 3600)
        let all = sessions.flatMap { [$0.start, $0.end] } + catchUp.map(\.availableAt) + prayers.map { $0.start.addingTimeInterval(30 * 60) }
        return Array(Set(all.filter { $0 > now && $0 <= limit })).sorted()
    }
}

// ---------- formatting (Hebrew) ----------
enum Fmt {
    static let days = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"]

    private static let hm: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX") // 24-hour, whatever the Mac's 12/24h setting
        f.dateFormat = "HH:mm"
        return f
    }()

    static func time(_ d: Date) -> String { hm.string(from: d) }

    /// "היום 10:00" / "מחר 10:00" / "יום ג׳ 20.10 10:00"
    static func day(_ d: Date, withTime: Bool = true) -> String {
        let cal = Calendar.current
        let t = withTime ? " " + time(d) : ""
        if cal.isDateInToday(d) { return "היום" + t }
        if cal.isDateInTomorrow(d) { return "מחר" + t }
        let c = cal.dateComponents([.weekday, .day, .month], from: d)
        return "יום \(days[(c.weekday ?? 1) - 1]) \(c.day ?? 0).\(c.month ?? 0)" + t
    }

    /// "בעוד 25 דק׳" / "בעוד שעתיים" — for the next class
    static func until(_ d: Date, from now: Date) -> String {
        let min = Int(d.timeIntervalSince(now) / 60)
        if min < 1 { return "עכשיו" }
        if min < 60 { return "בעוד \(min) דק׳" }
        let h = Int((Double(min) / 60).rounded())
        return h == 1 ? "בעוד שעה" : h == 2 ? "בעוד שעתיים" : "בעוד \(h) שעות"
    }
}

extension Color {
    /// "#d97706" → Color (falls back to the app blue)
    init(hex: String) {
        var v: UInt64 = 0x1f5fd1
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if s.count == 6 { Scanner(string: s).scanHexInt64(&v) }
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
    static let brand = Color(hex: "#1f5fd1")
}
