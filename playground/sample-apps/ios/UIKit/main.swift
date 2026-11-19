import UIKit
import WebKit

// The UIKit half of the tree measurement sample. Every tappable element sets the status label to
// `tapped:<id>`, so the measurement script proves a tap landed by reading the tree again rather than by
// looking at the screen. Ids match `../../expected/` and the SwiftUI target.

final class Status {
    static let shared = Status()
    let label = UILabel()

    private init() {
        label.text = "tapped:none"
        label.accessibilityIdentifier = "status"
        label.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        label.textAlignment = .center
    }

    func tapped(_ id: String) {
        label.text = "tapped:\(id)"
    }
}

// MARK: - Form

final class FormViewController: UIViewController, UITextFieldDelegate {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let email = UITextField()
        email.placeholder = "Email"
        email.accessibilityIdentifier = "form.email"
        email.borderStyle = .roundedRect
        email.delegate = self

        let password = UITextField()
        password.placeholder = "Password"
        password.isSecureTextEntry = true
        password.accessibilityIdentifier = "form.password"
        password.borderStyle = .roundedRect
        password.delegate = self

        let notifyLabel = UILabel()
        notifyLabel.text = "Notifications"
        let notify = UISwitch()
        notify.accessibilityIdentifier = "form.notify"
        notify.accessibilityLabel = "Notifications"
        notify.addAction(UIAction { _ in Status.shared.tapped("form.notify") }, for: .valueChanged)
        let notifyRow = UIStackView(arrangedSubviews: [notifyLabel, notify])

        let volume = UISlider()
        volume.accessibilityIdentifier = "form.volume"
        volume.accessibilityLabel = "Volume"
        // Centred like the SwiftUI target's, so the same swipe from the middle starts on the thumb in both.
        volume.value = 0.5
        // Reported when the value changes, as the SwiftUI target's drag is — so "landed" means the same in both.
        volume.addAction(UIAction { _ in Status.shared.tapped("form.volume") }, for: .valueChanged)

        let submit = UIButton(type: .system)
        submit.setTitle("Submit", for: .normal)
        submit.accessibilityIdentifier = "form.submit"
        submit.addAction(UIAction { [weak self] _ in
            self?.view.endEditing(true)
            Status.shared.tapped("form.submit")
        }, for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [email, password, notifyRow, volume, submit])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
    }

    func textFieldDidBeginEditing(_ textField: UITextField) {
        Status.shared.tapped(textField.accessibilityIdentifier ?? "form.unknown")
    }
}

// MARK: - List

final class ListViewController: UITableViewController {
    private let scrim = UIView()
    private let close = UIButton(type: .system)
    private var decorY: NSLayoutConstraint?

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.accessibilityIdentifier = "list.table"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        addLayers()
    }

    /// Three layers over the rows, as the SwiftUI target has them: a label that takes no touches over Row 5, a floating
    /// button at the bottom right, and the scrim it opens over every row until Close. Pinned to the table's frame, not
    /// its content, so they stay put while the rows scroll under them.
    private func addLayers() {
        let frame = tableView.frameLayoutGuide
        let decor = UILabel()
        decor.text = "  Decor  "
        decor.backgroundColor = UIColor.systemYellow.withAlphaComponent(0.5)
        decor.layer.cornerRadius = 16
        decor.clipsToBounds = true
        decor.isUserInteractionEnabled = false
        decor.accessibilityIdentifier = "list.decor"
        let fab = UIButton(type: .system)
        fab.setImage(UIImage(systemName: "plus"), for: .normal)
        fab.tintColor = .white
        fab.backgroundColor = .systemBlue
        fab.layer.cornerRadius = 28
        fab.accessibilityLabel = "Add"
        fab.accessibilityIdentifier = "list.fab"
        fab.addAction(UIAction { [weak self] _ in Status.shared.tapped("list.fab"); self?.showScrim(true) }, for: .touchUpInside)
        scrim.backgroundColor = UIColor.black.withAlphaComponent(0.3)
        scrim.accessibilityIdentifier = "list.scrim"
        scrim.isHidden = true
        scrim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(scrimTapped)))
        close.setTitle("Close", for: .normal)
        close.accessibilityIdentifier = "list.scrim.close"
        close.isHidden = true
        close.addAction(UIAction { [weak self] _ in Status.shared.tapped("list.scrim.close"); self?.showScrim(false) }, for: .touchUpInside)
        for v in [decor, fab, scrim, close] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            tableView.addSubview(v)
        }
        NSLayoutConstraint.activate([
            decor.centerXAnchor.constraint(equalTo: frame.centerXAnchor),
            decor.heightAnchor.constraint(equalToConstant: 44),
            fab.widthAnchor.constraint(equalToConstant: 56), fab.heightAnchor.constraint(equalToConstant: 56),
            // The safe area, not the frame: the table runs under the tab bar, which would cover the button.
            fab.trailingAnchor.constraint(equalTo: tableView.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            fab.bottomAnchor.constraint(equalTo: tableView.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            scrim.topAnchor.constraint(equalTo: frame.topAnchor), scrim.bottomAnchor.constraint(equalTo: frame.bottomAnchor),
            scrim.leadingAnchor.constraint(equalTo: frame.leadingAnchor), scrim.trailingAnchor.constraint(equalTo: frame.trailingAnchor),
            close.centerXAnchor.constraint(equalTo: frame.centerXAnchor), close.centerYAnchor.constraint(equalTo: frame.centerYAnchor),
        ])
        decorY = decor.centerYAnchor.constraint(equalTo: frame.topAnchor)
        decorY?.isActive = true
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // 40% down, as the SwiftUI target places it: over Row 5 or so, never over Row 0.
        decorY?.constant = tableView.frame.height * 0.4
        // Cells are added as they scroll in, above anything added before them: the layers go back on top.
        for id in ["list.decor", "list.fab", "list.scrim", "list.scrim.close"] {
            if let v = tableView.subviews.first(where: { $0.accessibilityIdentifier == id }) { tableView.bringSubviewToFront(v) }
        }
    }

    private func showScrim(_ shown: Bool) {
        scrim.isHidden = !shown
        close.isHidden = !shown
    }

    @objc private func scrimTapped() { Status.shared.tapped("list.scrim") }

    // Fifty rows so the list runs past the screen: rows that are not on screen are not loaded, and the
    // measurement records whether the tree reports them anyway.
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 50 }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = "Row \(indexPath.row)"
        cell.contentConfiguration = content
        cell.accessibilityIdentifier = "list.row.\(indexPath.row)"
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        Status.shared.tapped("list.row.\(indexPath.row)")
    }
}

// MARK: - Hard

/// Drawn by hand with no accessibility traits — what a custom control looks like when its author never
/// thought about accessibility. It carries an identifier, as a test-minded author would add, but is not
/// an accessibility element, so whether the tree sees it at all is the question.
final class CustomControl: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemOrange
        layer.cornerRadius = 8
        accessibilityIdentifier = "hard.custom"
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tap)))
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func tap() { Status.shared.tapped("hard.custom") }
}

final class HardViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        // A label and no identifier: a selector can only use the text.
        let help = UIButton(type: .system)
        help.setTitle("Help", for: .normal)
        help.addAction(UIAction { _ in Status.shared.tapped("hard.help") }, for: .touchUpInside)

        // An image and nothing else: no title, no accessibility label, no identifier.
        let trash = UIButton(type: .system)
        trash.setImage(UIImage(systemName: "trash"), for: .normal)
        trash.addAction(UIAction { _ in Status.shared.tapped("hard.image") }, for: .touchUpInside)

        let custom = CustomControl()
        custom.heightAnchor.constraint(equalToConstant: 44).isActive = true

        // Plain text that happens to be tappable, which is common and invisible to traits.
        let text = UILabel()
        text.text = "Tap this text"
        text.isUserInteractionEnabled = true
        text.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(textTapped)))

        // A field whose only text is its placeholder: no identifier, no label. Whether a selector can find it
        // depends on whether the tree carries the placeholder at all.
        let nickname = UITextField()
        nickname.placeholder = "Nickname"
        nickname.borderStyle = .roundedRect
        nickname.addAction(UIAction { _ in Status.shared.tapped("hard.field") }, for: .editingDidBegin)

        let stack = UIStackView(arrangedSubviews: [help, trash, custom, text, nickname])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
    }

    @objc private func textTapped() { Status.shared.tapped("hard.text") }
}

// MARK: - Gestures

/// What a flow's `longPressOn` and `pinch` steps act on. Plain views with identifiers, like `CustomControl`. A quick
/// tap and a long press on the hold area say different things, so a long press that arrived as a tap shows as one.
final class GesturesViewController: UIViewController {
    // Which way the app itself is drawn — what a flow's `setOrientation` should leave — read from the view's own size,
    // so a portrait-locked build stays portrait on a turned device.
    private let orientation = UILabel()

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        orientation.text = view.bounds.width > view.bounds.height ? "orientation:landscape" : "orientation:portrait"
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        orientation.textAlignment = .center
        orientation.accessibilityIdentifier = "gesture.orientation"

        let hold = UILabel()
        hold.text = "Hold me"
        hold.textAlignment = .center
        hold.backgroundColor = UIColor.systemBlue.withAlphaComponent(0.2)
        hold.isUserInteractionEnabled = true
        hold.accessibilityIdentifier = "gesture.hold"
        hold.heightAnchor.constraint(equalToConstant: 64).isActive = true
        let press = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        press.minimumPressDuration = 0.5
        hold.addGestureRecognizer(press)
        let tap = UITapGestureRecognizer(target: self, action: #selector(holdTapped))
        tap.require(toFail: press)
        hold.addGestureRecognizer(tap)

        // Judged once the fingers lift, by which way the scale went, so how far a pinch spread does not matter.
        let zoom = UIView()
        zoom.backgroundColor = UIColor.systemGreen.withAlphaComponent(0.2)
        zoom.accessibilityIdentifier = "gesture.zoom"
        zoom.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))

        let stack = UIStackView(arrangedSubviews: [orientation, hold, zoom])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        if recognizer.state == .began { Status.shared.tapped("gesture.hold.long") }
    }

    @objc private func holdTapped() { Status.shared.tapped("gesture.hold.short") }

    @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
        guard recognizer.state == .ended else { return }
        if recognizer.scale > 1.2 { Status.shared.tapped("gesture.zoom.in") }
        else if recognizer.scale < 0.8 { Status.shared.tapped("gesture.zoom.out") }
    }
}

// MARK: - Web

final class WebViewController: UIViewController, WKScriptMessageHandler {
    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "tapped")
        let web = WKWebView(frame: .zero, configuration: config)
        web.accessibilityIdentifier = "web.view"
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web"),
           let html = try? String(contentsOf: url, encoding: .utf8) {
            web.loadHTMLString(html, baseURL: nil)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let id = message.body as? String { Status.shared.tapped(id) }
    }
}

// MARK: - Root

/// The status label sits above the tab bar controller, so it is on screen whichever tab is selected.
final class RootViewController: UIViewController, UITabBarControllerDelegate {
    private let tabs = UITabBarController()
    private let tabIds = ["tab.form", "tab.list", "tab.hard", "tab.web", "tab.gestures"]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let screens: [(UIViewController, String, String)] = [
            (FormViewController(), "Form", "square.and.pencil"),
            (ListViewController(style: .plain), "List", "list.bullet"),
            (HardViewController(), "Hard", "exclamationmark.triangle"),
            (WebViewController(), "Web", "globe"),
            (GesturesViewController(), "Gestures", "hand.tap"),
        ]
        tabs.viewControllers = screens.enumerated().map { index, screen in
            let (vc, title, symbol) = screen
            vc.tabBarItem = UITabBarItem(title: title, image: UIImage(systemName: symbol), tag: index)
            vc.tabBarItem.accessibilityIdentifier = tabIds[index]
            return vc
        }
        tabs.delegate = self
        // What a flow's `pressButton: home` leaves behind, read once the app is brought back.
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            Status.shared.tapped("app.background")
        }

        let status = Status.shared.label
        status.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(status)
        addChild(tabs)
        tabs.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(tabs.view)
        tabs.didMove(toParent: self)
        NSLayoutConstraint.activate([
            status.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            status.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            status.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            status.heightAnchor.constraint(equalToConstant: 28),
            tabs.view.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 8),
            tabs.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            tabs.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabs.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        Status.shared.tapped(tabIds[viewController.tabBarItem.tag])
    }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = RootViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
