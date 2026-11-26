// Times from the Hebcal calendar (its address is in mac/hebcal.local, not committed): candle
// lighting before Shabbat and Yom Tov, which Hanukkah candle is lit tonight, the Omer count and
// when a fast ends.
// Fetched once a week (Hebcal publishes years ahead) and kept, so it works offline.
import Foundation

struct HebcalEvent: Codable {
    let title: String
    let date: Date
    let allDay: Bool
}

enum Hebcal {
    static let key = "hebcal" // ⚙️ toggle
    private static let cacheKey = "hebcalEvents2", fetchedKey = "hebcalFetched2" // bump when parse() keeps more
    static var configured: Bool { !Config.hebcalURL.isEmpty }

    static let cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Jerusalem")!
        return c
    }()

    static func cached() -> [HebcalEvent] {
        guard let d = UserDefaults.standard.data(forKey: cacheKey) else { return [] }
        return (try? JSONDecoder().decode([HebcalEvent].self, from: d)) ?? []
    }

    /// New events if the copy is over a week old (or missing) and the fetch worked; else nil.
    static func refreshIfStale() async -> [HebcalEvent]? {
        guard configured, let url = URL(string: Config.hebcalURL) else { return nil }
        let last = UserDefaults.standard.object(forKey: fetchedKey) as? Date
        if let last, Date().timeIntervalSince(last) < 7 * 86400, !cached().isEmpty { return nil }
        guard let (data, res) = try? await URLSession.shared.data(from: url),
              (res as? HTTPURLResponse)?.statusCode == 200,
              let ics = String(data: data, encoding: .utf8) else { return nil }
        let events = parse(ics)
        guard !events.isEmpty else { return nil }
        UserDefaults.standard.set(try? JSONEncoder().encode(events), forKey: cacheKey)
        UserDefaults.standard.set(Date(), forKey: fetchedKey)
        return events
    }

    /// Only what's shown: candle lighting, Hanukkah candles, the Omer and fast ends.
    static func parse(_ ics: String) -> [HebcalEvent] {
        let lines = ics.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n ", with: "") // unfold long lines
            .components(separatedBy: "\n")
        var out: [HebcalEvent] = []
        var title = "", start = "", inEvent = false, inAlarm = false
        for line in lines {
            if line == "BEGIN:VEVENT" { inEvent = true; title = ""; start = ""; continue }
            if line == "BEGIN:VALARM" { inAlarm = true; continue }
            if line == "END:VALARM" { inAlarm = false; continue }
            if line == "END:VEVENT" {
                inEvent = false
                let wanted = title == "הדלקת נרות" || title.hasPrefix("חנוכה:") || title.hasSuffix("בעומר")
                    || title == "סיום הצום"
                if wanted, let (date, allDay) = parseDate(start) {
                    out.append(HebcalEvent(title: title, date: date, allDay: allDay))
                }
                continue
            }
            guard inEvent, !inAlarm, let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon], value = String(line[line.index(after: colon)...])
            if name == "SUMMARY" { title = value }
            else if name.hasPrefix("DTSTART") { start = value }
        }
        return out.sorted { $0.date < $1.date }
    }

    /// "20261204T155900" (Jerusalem time) or "20270423" (all day)
    private static func parseDate(_ s: String) -> (Date, Bool)? {
        let digits = s.filter(\.isNumber)
        func n(_ a: Int, _ b: Int) -> Int? {
            guard digits.count >= b else { return nil }
            let i = digits.index(digits.startIndex, offsetBy: a), j = digits.index(digits.startIndex, offsetBy: b)
            return Int(digits[i..<j])
        }
        guard let y = n(0, 4), let m = n(4, 6), let d = n(6, 8) else { return nil }
        let allDay = !s.contains("T")
        let c = DateComponents(year: y, month: m, day: d, hour: allDay ? 12 : n(8, 10), minute: allDay ? 0 : n(10, 12))
        return cal.date(from: c).map { ($0, allDay) }
    }
}

extension Array where Element == HebcalEvent {
    private func on(_ d: Date) -> [HebcalEvent] { filter { Hebcal.cal.isDate($0.date, inSameDayAs: d) } }

    /// Today's candle lighting (Friday / Erev Chag), while it's still ahead.
    func candleLighting(_ now: Date) -> Date? {
        on(now).first { $0.title == "הדלקת נרות" && $0.date > now }?.date
    }

    /// When today's fast ends, while it's still ahead.
    func fastEnd(_ now: Date) -> Date? {
        on(now).first { $0.title == "סיום הצום" && $0.date > now }?.date
    }

    /// The next candle lighting, today or later.
    func nextCandleLighting(_ now: Date) -> Date? {
        first { $0.title == "הדלקת נרות" && $0.date > now }?.date
    }

    /// Tonight's Hanukkah candle ("נר שלישי") and when, from the morning until midnight.
    func hanukkah(_ now: Date) -> (name: String, at: Date)? {
        guard let e = on(now).first(where: { $0.title.hasPrefix("חנוכה:") && !$0.allDay }) else { return nil }
        let letters = "אבגדהוזח"
        let ordinals = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שביעי", "שמיני"]
        let letter = e.title.dropFirst("חנוכה:".count).trimmingCharacters(in: .whitespaces).first
        guard let l = letter, let i = letters.firstIndex(of: l) else { return nil }
        return ("נר " + ordinals[letters.distance(from: letters.startIndex, to: i)], e.date)
    }

    /// The Omer count of the current Hebrew day: from sunset it's already tonight's count.
    func omer(_ now: Date) -> HebcalEvent? {
        on(HebrewDate.day(now)).first { $0.title.hasSuffix("בעומר") }
    }
}
