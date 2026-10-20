// The window that opens from the menu bar icon.
import AppKit
import SwiftUI

struct Panel: View {
    @EnvironmentObject var model: Model
    @State private var showSettings = false
    // The menu bar window takes its size from the content, but a ScrollView has no height of its
    // own — so the list is measured and the ScrollView gets exactly that (up to a maximum).
    @State private var listHeight: CGFloat = 0
    private let maxListHeight: CGFloat = 520

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if showSettings {
                SettingsView(close: { showSettings = false })
            } else if let s = model.summary {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        classes(s)
                        catchUp(s)
                        tasks(s)
                        prayers(s)
                    }
                    .padding(14)
                    .background(GeometryReader { g in
                        Color.clear.preference(key: ListHeightKey.self, value: g.size.height)
                    })
                }
                .frame(height: min(max(listHeight, 80), maxListHeight))
                .onPreferenceChange(ListHeightKey.self) { listHeight = $0 }
            } else {
                Text(model.loading ? "טוען…" : (model.error ?? "אין נתונים"))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 120)
            }
            Divider()
            footer
        }
        .frame(width: 340)
        .task { await model.refresh() }
    }

    // ---------- header / footer ----------
    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text("הסמסטרון").font(.headline)
                Text(model.summary?.semester ?? "").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let e = model.error {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).help(e)
            }
            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .rotationEffect(.degrees(model.loading ? 180 : 0))
                    .animation(.easeInOut(duration: 0.4), value: model.loading)
            }
            .buttonStyle(PanelButtonStyle())
            .help("רענן")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var footer: some View {
        HStack {
            Button("פתח את הסמסטרון") { WebApp.open() }.buttonStyle(PanelButtonStyle(tint: .brand))
            Spacer()
            if let n = model.summary?.inbox, n > 0 {
                Button("🔔 \(n)") { WebApp.open(query: "?inbox=1") }.help("עדכונים שלא נקראו")
            }
            Button { showSettings.toggle() } label: { Image(systemName: "gearshape") }.help("הגדרות")
            Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }.help("יציאה")
        }
        .buttonStyle(PanelButtonStyle())
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    // ---------- sections ----------
    @ViewBuilder private func classes(_ s: Summary) -> some View {
        let coming = s.comingSessions(model.now)
        let today = coming.filter { Calendar.current.isDateInToday($0.start) || $0.start <= model.now }
        let list = today.isEmpty ? Array(coming.prefix(1)) : today
        Section(title: today.isEmpty ? "השיעור הבא" : "היום") {
            if list.isEmpty {
                Empty("אין שיעורים בימים הקרובים")
            }
            ForEach(list) { c in
                let live = c.start <= model.now
                Row(color: c.color) {
                    HStack(spacing: 6) {
                        Text(c.title).font(.callout.weight(.medium))
                        if live { Pill("עכשיו", color: .red) }
                        if c.done { Pill("✓", color: .green) }
                    }
                    Text(meta(c)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func meta(_ c: Session) -> String {
        var parts = [today(c.start) ? "\(Fmt.time(c.start))–\(Fmt.time(c.end))" : Fmt.day(c.start)]
        if !c.room.isEmpty { parts.append("📍 \(c.room)") }
        if c.start > model.now, today(c.start) { parts.append(Fmt.until(c.start, from: model.now)) }
        return parts.joined(separator: " · ")
    }

    private func today(_ d: Date) -> Bool { Calendar.current.isDateInToday(d) }

    @ViewBuilder private func catchUp(_ s: Summary) -> some View {
        let owed = s.toCatchUp(model.now, done: model.doneHere)
        Section(title: owed.isEmpty ? "להשלים" : "להשלים (\(owed.count))") {
            if owed.isEmpty { Empty("הכל מעודכן ✓") }
            ForEach(owed.prefix(8)) { u in
                Row(color: u.color) {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(u.emoji) \(u.short) · \(u.label)").font(.callout)
                            if !u.topic.isEmpty { Text(u.topic).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        }
                        Spacer()
                        if let r = u.recording {
                            Button("▶") { open(r) }.buttonStyle(PanelButtonStyle(tint: .brand)).help("צפה בהקלטה")
                        }
                        doneButton(u.key)
                    }
                }
            }
            if owed.count > 8 {
                Text("ועוד \(owed.count - 8)…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func tasks(_ s: Summary) -> some View {
        let open = s.openTasks(model.doneHere)
        if !open.isEmpty {
            Section(title: "הגשות ובחינות") {
                ForEach(open.prefix(5)) { t in
                    Row(color: t.color) {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text("\(t.emoji) \(t.title)").font(.callout).lineLimit(1)
                                Text(Fmt.day(t.due)).font(.caption)
                                    .foregroundStyle(t.due.timeIntervalSince(model.now) < 86400 ? .red : .secondary)
                            }
                            Spacer()
                            if t.kind != "exam" { doneButton(t.key) }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func prayers(_ s: Summary) -> some View {
        let list = s.todaysPrayers(model.now, done: model.doneHere)
        if !list.isEmpty {
            Section(title: "תפילות") {
                ForEach(list) { p in
                    Row(color: "#888888") {
                        HStack {
                            Text("🙏 \(p.label) \(p.approx ? "≈" : "")\(Fmt.time(p.start)) · \(p.place)").font(.callout)
                            Spacer()
                            doneButton(p.key)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func doneButton(_ key: String) -> some View {
        if model.hasToken {
            Button("✓") { Task { await model.markDone(key) } }
                .buttonStyle(PanelButtonStyle(tint: .green))
                .help("סיימתי")
        }
    }

    private func open(_ url: String) {
        // links come from the synced data: open only web pages, never other app/file URLs
        if let u = URL(string: url), u.scheme == "https" { NSWorkspace.shared.open(u) }
    }
}

// ---------- small building blocks ----------
/// Panel buttons: a tinted highlight on hover, darker while pressed, a slight press-in and a
/// hand cursor — the plain borderless style gives no feedback at all.
struct PanelButtonStyle: ButtonStyle {
    var tint: Color = .primary

    func makeBody(configuration: Configuration) -> some View {
        PanelButton(configuration: configuration, tint: tint)
    }

    private struct PanelButton: View {
        let configuration: Configuration
        let tint: Color
        @State private var hover = false
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .foregroundStyle(tint)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 6)
                    .fill(tint.opacity(configuration.isPressed ? 0.24 : hover && enabled ? 0.12 : 0)))
                .scaleEffect(configuration.isPressed ? 0.94 : 1)
                .opacity(enabled ? 1 : 0.4)
                .contentShape(RoundedRectangle(cornerRadius: 6))
                .animation(.easeOut(duration: 0.12), value: hover)
                .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
                .onHover { inside in
                    hover = inside
                    if inside && enabled { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
                .onDisappear { if hover { NSCursor.pop() } }
        }
    }
}

private struct ListHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct Section<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content
        }
    }
}

private struct Row<Content: View>: View {
    let color: String
    @ViewBuilder let content: Content
    var body: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(Color(hex: color)).frame(width: 3)
            VStack(alignment: .leading, spacing: 2) { content }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct Pill: View {
    let text: String
    let color: Color
    init(_ text: String, color: Color) { self.text = text; self.color = color }
    var body: some View {
        Text(text).font(.caption2.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.15), in: Capsule())
    }
}

private struct Empty: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.callout).foregroundStyle(.secondary) }
}

struct SettingsView: View {
    @EnvironmentObject var model: Model
    let close: () -> Void
    @State private var token = ""
    @State private var atLogin = false
    @AppStorage(MenuBarMode.key) private var mode = MenuBarMode.full.rawValue

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("הגדרות").font(.headline)
            VStack(alignment: .leading, spacing: 4) {
                Text("בסרגל התפריטים").font(.callout.weight(.medium))
                Picker("", selection: $mode) {
                    ForEach(MenuBarMode.allCases, id: \.rawValue) { Text($0.label).tag($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if mode == MenuBarMode.hidden.rawValue {
                    Text("הסמל ייעלם עם סגירת החלון. כדי להחזיר אותו: ⚙️ בווידג׳ט (בינוני או גדול), או לפתוח את האפליקציה שוב.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Toggle("הפעל בכניסה למחשב", isOn: $atLogin)
                .onChange(of: atLogin) { _, on in model.setLaunchAtLogin(on) }
            VStack(alignment: .leading, spacing: 4) {
                Text("כפתורי ✓ (סימון כבוצע)").font(.callout.weight(.medium))
                Text(model.hasToken
                     ? "מחובר — הטוקן שמור ב-Keychain."
                     : "כדי לסמן מכאן, הדבק את אותו טוקן GitHub שהדבקת באפליקציה (⚙️ → סנכרון). בלי טוקן הכל מוצג, רק בלי ✓.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    SecureField("ghp_…", text: $token)
                    Button("שמור") { model.setToken(token); token = "" }.disabled(token.isEmpty)
                    if model.hasToken { Button("הסר") { model.setToken(nil) } }
                }
            }
            HStack {
                Spacer()
                Button("סגור", action: close)
            }
        }
        .padding(14)
        .onAppear { atLogin = model.launchAtLogin }
    }
}
