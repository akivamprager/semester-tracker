// The panel's background, made to look like the system's own menu bar items (Weather, Control
// Center…) on macOS 26+: Liquid Glass with their larger rounded corners. On older macOS nothing
// changes.
//
// MenuBarExtra draws its own older background (a blur, a grey tint and a faint colour layer —
// plain rectangles, which the window server cuts with its smaller corners) as the first views
// of its hosting view, under the panel. Those are hidden here, otherwise they show around the
// glass's corners.
import AppKit
import SwiftUI

struct PanelBackground: NSViewRepresentable {
    /// The system menu bar items' corner radius (measured on Weather's).
    static let cornerRadius: CGFloat = 16

    func makeNSView(context: Context) -> NSView {
        if #available(macOS 26, *) { return PanelGlass() }
        return NSView()
    }

    func updateNSView(_ view: NSView, context: Context) {}
}

@available(macOS 26, *)
private final class PanelGlass: NSGlassEffectView {
    private var observer: NSObjectProtocol?

    override init(frame: NSRect) {
        super.init(frame: frame)
        cornerRadius = PanelBackground.cornerRadius
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        guard let window else { return }
        // the window is reused each time the panel opens — check again then
        observer = NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.adoptWindow() }
        }
        DispatchQueue.main.async { [weak self] in self?.adoptWindow() }
    }

    override func layout() {
        super.layout()
        hideSystemBackground()
    }

    private func adoptWindow() {
        guard let window else { return }
        window.isOpaque = false
        window.backgroundColor = .clear
        hideSystemBackground()
        // the shadow follows what's drawn — now the glass's shape
        window.invalidateShadow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak window] in window?.invalidateShadow() }
    }

    /// Everything in the hosting view below this background is MenuBarExtra's own.
    private func hideSystemBackground() {
        guard let hosting = hostingView(),
              let mine = hosting.subviews.firstIndex(where: { self.isDescendant(of: $0) }) else { return }
        for view in hosting.subviews[..<mine] where !view.isHidden { view.isHidden = true }
    }

    /// The outermost SwiftUI hosting view this background is in (MenuBarExtra's).
    private func hostingView() -> NSView? {
        var found: NSView?
        var v = superview
        while let view = v {
            if String(describing: type(of: view)).contains("HostingView") { found = view }
            v = view.superview
        }
        return found
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}
