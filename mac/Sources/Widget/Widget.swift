// הסמסטרון widget (desktop / Notification Center). Fetches widget.json itself (the widget runs
// sandboxed, apart from the menu bar app); the timeline has an entry at every class start/end,
// so "next class" moves on by itself between refreshes (every ~30 minutes).
import SwiftUI
import WidgetKit

@main
struct HasemestronWidgets: WidgetBundle {
    var body: some Widget { HasemestronWidget() }
}

struct HasemestronWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "hasemestron", provider: Provider()) { entry in
            EntryView(entry: entry)
                .environment(\.layoutDirection, .rightToLeft)
                .containerBackground(.background, for: .widget)
                .widgetURL(URL(string: "hasemestron://open")) // the menu bar app opens the app window
        }
        .configurationDisplayName("הסמסטרון")
        .description("השיעור הבא, מה להשלים והגשות קרובות.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct Entry: TimelineEntry {
    let date: Date
    let summary: Summary?
}

struct Provider: TimelineProvider {
    private let cacheKey = "summary"

    func placeholder(in context: Context) -> Entry { Entry(date: Date(), summary: cached()) }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date(), summary: cached()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        Task {
            var summary = cached()
            if let (fresh, data) = try? await Feed.fetch() {
                summary = fresh
                UserDefaults.standard.set(data, forKey: cacheKey)
            }
            let now = Date()
            let points = [now] + (summary?.changePoints(after: now, within: 12) ?? []).prefix(30)
            let entries = points.map { Entry(date: $0, summary: summary) }
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60))))
        }
    }

    private func cached() -> Summary? {
        UserDefaults.standard.data(forKey: cacheKey).flatMap { try? Feed.decode($0) }
    }
}

struct EntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        if let s = entry.summary {
            switch family {
            case .systemSmall: small(s)
            case .systemMedium: medium(s)
            default: large(s)
            }
        } else {
            VStack(spacing: 6) {
                Image(systemName: "graduationcap.fill").font(.title).foregroundStyle(Color.brand)
                Text("הסמסטרון").font(.headline)
                Text("ממתין לנתונים…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var now: Date { entry.date }

    // ---------- sizes ----------
    private func small(_ s: Summary) -> some View {
        let owed = s.toCatchUp(now).count
        return VStack(alignment: .leading, spacing: 4) {
            brand
            Spacer(minLength: 0)
            Text("\(owed)").font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(owed > 0 ? Color.brand : .green)
            Text(owed > 0 ? "להשלים" : "הכל מעודכן").font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if let n = s.comingSessions(now).first { nextLine(n).font(.caption2).lineLimit(2) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func medium(_ s: Summary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack { brand; Spacer(); settingsLink }
                Spacer(minLength: 0)
                if let n = s.comingSessions(now).first {
                    sessionBlock(n)
                } else {
                    Text("אין שיעורים בימים הקרובים").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                let owed = s.toCatchUp(now)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("\(owed.count)").font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(owed.isEmpty ? .green : Color.brand)
                    Text(owed.isEmpty ? "הכל מעודכן" : "להשלים").font(.caption).foregroundStyle(.secondary)
                }
                if let t = s.openTasks().first { taskLine(t) }
                if let p = s.todaysPrayers(now).first {
                    Text("🙏 \(p.label) \(Fmt.time(p.start))").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func large(_ s: Summary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { brand; Spacer(); Text(s.semester).font(.caption2).foregroundStyle(.secondary); settingsLink }
            group("שיעורים") {
                let coming = Array(s.comingSessions(now).prefix(3))
                if coming.isEmpty { muted("אין שיעורים בימים הקרובים") }
                ForEach(coming) { c in
                    bar(c.color) {
                        Text(c.title).font(.caption.weight(.medium))
                        Text("\(Fmt.day(c.start))\(c.room.isEmpty ? "" : " · 📍 \(c.room)")").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            group("להשלים (\(s.toCatchUp(now).count))") {
                let owed = Array(s.toCatchUp(now).prefix(4))
                if owed.isEmpty { muted("הכל מעודכן ✓") }
                ForEach(owed) { u in
                    bar(u.color) { Text("\(u.emoji) \(u.short) · \(u.label)\(u.recording != nil ? " ▶" : "")").font(.caption) }
                }
            }
            group("הגשות") {
                let open = Array(s.openTasks().prefix(3))
                if open.isEmpty { muted("אין הגשות בשבועיים הקרובים") }
                ForEach(open) { taskLine($0) }
            }
            Spacer(minLength: 0)
        }
    }

    // ---------- pieces ----------
    private var brand: some View {
        HStack(spacing: 4) {
            Image(systemName: "graduationcap.fill").foregroundStyle(Color.brand)
            Text("הסמסטרון").font(.caption.weight(.semibold))
        }
    }

    /// ⚙️ → the menu bar app (shows its icon again if it was hidden). Links work in medium/large only.
    private var settingsLink: some View {
        Link(destination: URL(string: "hasemestron://show")!) {
            Image(systemName: "gearshape").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func nextLine(_ n: Session) -> some View {
        let live = n.start <= now
        return Text("\(live ? "עכשיו" : Fmt.day(n.start)): \(n.emoji) \(n.short)\(n.room.isEmpty ? "" : " · \(n.room)")")
            .foregroundStyle(live ? .red : .secondary)
    }

    private func sessionBlock(_ n: Session) -> some View {
        let live = n.start <= now
        return VStack(alignment: .leading, spacing: 2) {
            Text(live ? "עכשיו · עד \(Fmt.time(n.end))" : Fmt.day(n.start))
                .font(.caption.weight(.semibold)).foregroundStyle(live ? .red : Color.brand)
            Text("\(n.emoji) \(n.short)").font(.headline).lineLimit(1)
            if !n.label.isEmpty { Text(n.label).font(.caption).foregroundStyle(.secondary) }
            if !n.room.isEmpty { Text("📍 \(n.room)").font(.caption).lineLimit(1) }
        }
    }

    private func taskLine(_ t: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(t.emoji) \(t.title)").font(.caption).lineLimit(1)
            Text(Fmt.day(t.due)).font(.caption2)
                .foregroundStyle(t.due.timeIntervalSince(now) < 86400 ? .red : .secondary)
        }
    }

    private func group<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }
    }

    private func bar<C: View>(_ color: String, @ViewBuilder _ content: () -> C) -> some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 1.5).fill(Color(hex: color)).frame(width: 3)
            VStack(alignment: .leading, spacing: 1) { content() }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func muted(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
    }
}
