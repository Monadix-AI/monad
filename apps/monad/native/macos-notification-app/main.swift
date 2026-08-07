import AppKit
import Foundation
import UserNotifications

private struct NotificationArguments {
    let title: String
    let subtitle: String
    let body: String
    let actionURL: String?

    init?(arguments: [String]) {
        guard arguments.contains("--notify") else { return nil }

        func value(after flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
                return nil
            }
            return arguments[index + 1]
        }

        guard let title = value(after: "--title"), let body = value(after: "--body") else { return nil }
        self.title = title
        self.subtitle = value(after: "--subtitle") ?? ""
        self.body = body
        self.actionURL = value(after: "--action-url")
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()

    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self
        guard let arguments = NotificationArguments(arguments: CommandLine.arguments) else {
            // Notification Center relaunches the app to deliver a click response. Keep the otherwise
            // headless helper alive briefly so the delegate callback can arrive.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                NSApplication.shared.terminate(nil)
            }
            return
        }

        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            guard granted, let self else {
                DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
                return
            }

            let content = UNMutableNotificationContent()
            content.title = arguments.title
            content.subtitle = arguments.subtitle
            content.body = arguments.body
            content.sound = .default
            if let actionURL = arguments.actionURL {
                content.userInfo["actionURL"] = actionURL
            }

            let request = UNNotificationRequest(
                identifier: "ai.monad.update.available",
                content: content,
                trigger: nil
            )
            self.center.add(request) { _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer {
            completionHandler()
            NSApplication.shared.terminate(nil)
        }
        guard
            response.actionIdentifier == UNNotificationDefaultActionIdentifier,
            let actionURL = response.notification.request.content.userInfo["actionURL"] as? String,
            let url = URL(string: actionURL)
        else { return }
        NSWorkspace.shared.open(url)
    }
}

let app = NSApplication.shared
private let delegate = AppDelegate()
app.delegate = delegate
_ = app.setActivationPolicy(.accessory)
app.run()
