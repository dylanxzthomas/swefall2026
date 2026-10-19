import UIKit
import Capacitor
import EventKit
import CryptoKit
import Security

// Real production plugins, real simulator APIs, synthetic content only.
// This deliberately bypasses the parent UI/backend and cannot prove their acceptance.
@MainActor final class NativeBoundaryController: UIViewController {
    private let keychain = DaymarkKeychainPlugin(), intake = DaymarkIntakePlugin(), calendar = DaymarkCalendarPlugin()
    private let events = EKEventStore()
    private let label = UILabel(), stack = UIStackView()
    private var checks: [String] = []
    private let fixtureText = "Synthetic native acceptance notice. No parent data, account, or cloud upload."
    private let key = "native-boundaries-synthetic-session"
    private var mode: String { let args = ProcessInfo.processInfo.arguments; return args.firstIndex(of: "--case").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil } ?? "unknown" }
    private var root: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("NativeBoundaries") }
    private enum Failure: LocalizedError { case assertion(String); var errorDescription: String? { if case .assertion(let message) = self { return message }; return nil } }

    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        label.text = "Native boundary tests · \(mode)"; label.numberOfLines = 0; label.font = .preferredFont(forTextStyle: .body)
        stack.axis = .vertical; stack.spacing = 24; stack.translatesAutoresizingMaskIntoConstraints = false; stack.addArrangedSubview(label); view.addSubview(stack)
        NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 30), stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24)])
        if mode == "calendar-permission" { button("Request Calendar access", "calendar-access") { await self.run { let value = try await self.call(self.calendar.connect); try self.require(value["permission"] as? String == "granted", "EventKit full access granted") } }; return }
        if mode == "share" {
            button("Share synthetic PDF", "share-pdf") { await self.share(pdf: true) }
            button("Check PDF handoff", "check-pdf") { await self.run(name: "share-pdf") { try await self.checkShare(pdf: true) } }
            button("Share synthetic image", "share-image") { await self.share(pdf: false) }
            button("Check image handoff", "check-image") { await self.run(name: "share-image") { try await self.checkShare(pdf: false) } }
            button("Request Calendar access", "calendar-access") { await self.run(name: "calendar-permission") { let value = try await self.call(self.calendar.connect); try self.require(value["permission"] as? String == "granted", "EventKit full access granted") } }
            return
        }
        Task { await run { try await self.perform() } }
    }
    private func button(_ title: String, _ id: String, action: @escaping () async -> Void) {
        let button = UIButton(type: .system); button.setTitle(title, for: .normal); button.accessibilityIdentifier = id
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addAction(UIAction { _ in Task { await action() } }, for: .touchUpInside); stack.addArrangedSubview(button)
    }
    private func run(name: String? = nil, _ body: () async throws -> Void) async {
        checks = []; let name = name ?? mode
        do { try await body(); try record(name, passed: true); label.text = "PASS \(name)" }
        catch { try? record(name, passed: false, error: error.localizedDescription); label.text = "FAIL \(name): \(error.localizedDescription)" }
    }
    private func require(_ valid: Bool, _ description: String) throws { guard valid else { throw Failure.assertion(description) }; checks.append(description) }
    private func call(_ method: (CAPPluginCall) -> Void, _ options: [String: Any] = [:]) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            // Match CapacitorBridge's real JS-call coercion, including nested objects.
            let bridged = JSTypes.coerceDictionaryToJSObject(options) ?? [:]
            let call = CAPPluginCall(callbackId: UUID().uuidString, methodName: "nativeAcceptance", options: bridged, success: { result, _ in continuation.resume(returning: result?.data ?? [:]) }, error: { error in continuation.resume(throwing: Failure.assertion(error?.message ?? "Native plugin rejected the call")) })!
            method(call)
        }
    }
    private func rejected(_ description: String, _ body: () async throws -> Void) async throws {
        do { try await body() } catch { checks.append(description); return }
        throw Failure.assertion(description)
    }
    private func write(_ value: [String: Any], _ name: String) throws { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: root.appendingPathComponent(name + ".json"), options: .atomic) }
    private func read(_ name: String) throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(name + ".json"))) as! [String: Any] }
    private func record(_ name: String, passed: Bool, error: String? = nil) throws { try write(["case": name, "passed": passed, "checks": checks, "error": error ?? "", "evidence": "native plugin and simulator APIs; not parent UI, connected-account, physical-device or iCloud acceptance"], "result-" + name) }
    private func hash(_ value: [String: Any]) throws -> String { SHA256.hash(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])).map { String(format: "%02x", $0) }.joined() }
    private func operation(_ calendarId: String, title: String = "Synthetic native school notice", allDay: Bool = false) -> [String: Any] {
        let id = SHA256.hash(data: Data(UUID().uuidString.utf8)).map { String(format: "%02x", $0) }.joined()
        let start = ISO8601DateFormatter().date(from: allDay ? "2027-02-12T00:00:00+09:00" : "2027-02-12T17:00:00Z")!.timeIntervalSince1970 * 1000
        return ["operationId": id, "approvalHash": id, "calendarId": calendarId, "operation": "save", "title": title, "location": "Synthetic gate", "notes": "Disposable native acceptance fixture", "timezone": allDay ? "Asia/Tokyo" : "America/Los_Angeles", "start": start, "end": start + (allDay ? 86400000 : 3600000), "allDay": allDay]
    }
    private func ownedCalendar() throws -> EKCalendar {
        events.reset(); let fixture = try read("calendar-fixture")
        guard let id = fixture["calendarId"] as? String, let expected = fixture["title"] as? String, expected.hasPrefix("Daymark Native Acceptance "), let value = events.calendar(withIdentifier: id), value.title == expected, value.source.sourceType == .local else { throw Failure.assertion("Only the recorded synthetic local calendar may be used") }
        return value
    }
    private func count(_ value: EKCalendar) -> Int { events.reset(); return events.events(matching: events.predicateForEvents(withStart: ISO8601DateFormatter().date(from: "2027-02-01T00:00:00Z")!, end: ISO8601DateFormatter().date(from: "2027-03-01T00:00:00Z")!, calendars: [value])).count }
    private func perform() async throws {
        switch mode {
        case "keychain-write":
            _ = try await call(keychain.set, ["key": key, "value": "synthetic-session-value"])
            let value = try await call(keychain.get, ["key": key]); try require(value["value"] as? String == "synthetic-session-value", "Keychain native write/read")
            try write(try await call(calendar.installation), "installation-fixture")
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.dylanxzthomas.wren.daymark.auth", kSecAttrAccount as String: key, kSecReturnAttributes as String: true]
            var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
            try require(status == errSecSuccess && (result as? [String: Any])?[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String, "Keychain uses device-only after-first-unlock protection")
        case "keychain-relaunch":
            let value = try await call(keychain.get, ["key": key]); try require(value["value"] as? String == "synthetic-session-value", "Keychain survives app process termination")
            let installation = try await call(calendar.installation); try require(installation["deviceId"] as? String == read("installation-fixture")["deviceId"] as? String, "Installation identity survives app process termination")
            _ = try await call(keychain.set, ["key": key, "value": "synthetic-updated-session"])
            let updated = try await call(keychain.get, ["key": key]); try require(updated["value"] as? String == "synthetic-updated-session", "Keychain update replaces the existing value")
            let keys = try await call(keychain.keys); try require((keys["keys"] as? [String])?.filter { $0 == key }.count == 1, "Keychain update does not duplicate keys")
            _ = try await call(keychain.remove, ["key": key]); _ = try await call(keychain.remove, ["key": key]); let removed = try await call(keychain.get, ["key": key]); try require(removed["value"] == nil, "Keychain removal and repeated removal")
        case "intake-atomic": try await intakeAtomic()
        case "calendar-create":
            try require(EKEventStore.authorizationStatus(for: .event) == .fullAccess, "Actual EventKit full-access authorization")
            guard let local = events.sources.first(where: { $0.sourceType == .local }) else { throw Failure.assertion("No local EventKit source exists; an Apple account must not be substituted") }
            let value = EKCalendar(for: .event, eventStore: events); value.source = local; value.title = "Daymark Native Acceptance " + UUID().uuidString
            try events.saveCalendar(value, commit: true); try write(["calendarId": value.calendarIdentifier, "title": value.title], "calendar-fixture")
            let status = try await call(calendar.status); try require((status["calendars"] as? [[String: Any]])?.contains(where: { $0["id"] as? String == value.calendarIdentifier }) == true, "Plugin lists the dedicated writable local calendar")
            try await calendarWrites(value)
        case "calendar-recover": try await recovery()
        case "calendar-denied":
            let status = try await call(calendar.status); try require(status["permission"] as? String == "denied" && (status["calendars"] as? [Any])?.isEmpty == true, "Denied permission hides calendars")
            let value = try read("calendar-fixture"), op = operation(value["calendarId"] as! String)
            try await rejected("Denied permission blocks writes") { _ = try await self.call(self.calendar.execute, ["operation": op]) }
        case "calendar-cleanup":
            let value = try ownedCalendar(), calendarId = value.calendarIdentifier; try require(count(value) == 2, "Denied attempt did not add an event")
            // count resets the independent store; fetch a fresh object before removal.
            try events.removeCalendar(ownedCalendar(), commit: true); events.reset(); try require(events.calendar(withIdentifier: calendarId) == nil, "Dedicated synthetic calendar removed")
            try await rejected("Missing calendar blocks a new write") { _ = try await self.call(self.calendar.execute, ["operation": self.operation(calendarId)]) }
        default: throw Failure.assertion("Unknown native test case")
        }
    }
    private func calendarWrites(_ value: EKCalendar) async throws {
        let op = operation(value.calendarIdentifier), saved = try await call(calendar.execute, ["operation": op])
        try require(saved["status"] as? String == "verified", "Native create has a verified read-back receipt")
        let eventId = saved["eventId"] as! String
        events.reset(); try require(events.event(withIdentifier: eventId)?.title == op["title"] as? String && count(value) == 1, "Independent EventKit read matches the created event")
        let repeated = try await call(calendar.execute, ["operation": op]); try require(repeated["eventId"] as? String == eventId && count(value) == 1, "Duplicate approval creates no additional event")
        var changed = op; changed["title"] = "Unapproved changed content"
        try await rejected("Same approval identity rejects changed content") { _ = try await self.call(self.calendar.execute, ["operation": changed]) }
        var update = operation(value.calendarIdentifier, title: "Synthetic corrected school notice"); update["eventId"] = eventId; update["expectedFingerprint"] = saved["fingerprint"]
        let corrected = try await call(calendar.execute, ["operation": update]); try require(corrected["status"] as? String == "verified" && count(value) == 1, "Update preserves one event with native read-back")
        events.reset(); guard let event = events.event(withIdentifier: eventId) else { throw Failure.assertion("Updated event disappeared") }
        try require(event.title == update["title"] as? String, "Independent EventKit read matches the correction")
        event.location = "External synthetic correction"; try events.save(event, span: .thisEvent, commit: true)
        var stale = operation(value.calendarIdentifier); stale["eventId"] = eventId; stale["expectedFingerprint"] = corrected["fingerprint"]
        let refused = try await call(calendar.execute, ["operation": stale]); try require(refused["status"] as? String == "review", "Stale approval stops after an external native edit")
        let before = try await call(calendar.read, ["eventId": eventId, "calendarId": value.calendarIdentifier])["event"] as! [String: Any]
        var removal = operation(value.calendarIdentifier); removal["operation"] = "delete"; removal["eventId"] = eventId; removal["expectedFingerprint"] = before["fingerprint"]
        let deleted = try await call(calendar.execute, ["operation": removal]); try require(deleted["status"] as? String == "verified" && count(value) == 0, "Deletion verified through EventKit absence")
        let again = try await call(calendar.execute, ["operation": removal]); try require(again["status"] as? String == "verified" && count(value) == 0, "Repeated deletion does not create or replay an event")
        let allDay = operation(value.calendarIdentifier, allDay: true), allDayResult = try await call(calendar.execute, ["operation": allDay])
        try require(allDayResult["status"] as? String == "verified", "All-day save verified across household and phone timezones")
        events.reset(); let allDayEvent = events.event(withIdentifier: allDayResult["eventId"] as! String)!
        try require(TimeZone.current.identifier != "Asia/Tokyo" && Calendar.current.component(.day, from: allDayEvent.startDate) == 12 && Calendar.current.component(.day, from: allDayEvent.endDate) == 13, "All-day floating date boundaries preserved")
        allDayEvent.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .daily, interval: 1, end: EKRecurrenceEnd(occurrenceCount: 2))); try events.save(allDayEvent, span: .thisEvent, commit: true)
        try await rejected("Native read refuses recurring events") { _ = try await self.call(self.calendar.read, ["eventId": allDayEvent.eventIdentifier!, "calendarId": value.calendarIdentifier]) }
        try events.remove(allDayEvent, span: .futureEvents, commit: true)
        let recoveryOp = operation(value.calendarIdentifier, title: "Synthetic interruption checkpoint"), result = try await call(calendar.execute, ["operation": recoveryOp])
        try require(result["status"] as? String == "verified", "Actual EventKit write exists before recovery fixture")
        // Model the durable checkpoint after EventKit returns but before receipt persistence.
        // Relaunch uses the actual production recovery path against the actual saved event.
        try seedAttempt(recoveryOp, eventId: result["eventId"] as? String)
        try write(recoveryOp, "recovery-operation")
        try require(count(value) == 1, "Only the recovery fixture remains before process termination")
    }
    private func seedAttempt(_ op: [String: Any], eventId: String? = nil) throws {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("DaymarkCalendar")
        var attempt: [String: Any] = ["operationHash": try hash(op)]; if let eventId { attempt["eventId"] = eventId }
        try JSONSerialization.data(withJSONObject: attempt, options: [.sortedKeys]).write(to: folder.appendingPathComponent((op["operationId"] as! String) + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func recovery() async throws {
        let value = try ownedCalendar(), op = try read("recovery-operation")
        let restored = try await call(calendar.reconcile, ["operation": op]); try require(restored["status"] as? String == "verified" && count(value) == 1, "Relaunched plugin recovers receipt from actual EventKit without duplicating")
        let absent = operation(value.calendarIdentifier, title: "Synthetic interrupted before write"); try seedAttempt(absent)
        for _ in 0..<2 { let uncertain = try await call(calendar.execute, ["operation": absent]); try require(uncertain["status"] as? String == "uncertain" && count(value) == 1, "Uncertain durable checkpoint never replays a write") }
        events.reset(); let duplicate = EKEvent(eventStore: events); duplicate.calendar = value; duplicate.title = op["title"] as? String; duplicate.location = op["location"] as? String; duplicate.notes = op["notes"] as? String; duplicate.startDate = Date(timeIntervalSince1970: (op["start"] as! Double) / 1000); duplicate.endDate = Date(timeIntervalSince1970: (op["end"] as! Double) / 1000); duplicate.url = URL(string: "daymark://calendar/" + (op["operationId"] as! String)); try events.save(duplicate, span: .thisEvent, commit: true)
        try seedAttempt(op, eventId: restored["eventId"] as? String)
        let ambiguous = try await call(calendar.reconcile, ["operation": op]); try require(ambiguous["status"] as? String == "uncertain" && count(value) == 2, "Duplicate native markers are reported as ambiguous")
    }
    private func intakeAtomic() async throws {
        guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.dylanxzthomas.wren.daymark") else { throw Failure.assertion("Signed test host has no App Group container") }
        let outbox = group.appendingPathComponent("DaymarkOutbox"); try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
        let id = UUID().uuidString, pending = outbox.appendingPathComponent("pending-" + id); try FileManager.default.createDirectory(at: pending, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: pending); try? FileManager.default.removeItem(at: outbox.appendingPathComponent(id)) }
        let manifest: [String: Any] = ["id": id, "text": fixtureText, "files": [["name": "missing.pdf", "type": "application/pdf"]]]
        try JSONSerialization.data(withJSONObject: manifest).write(to: pending.appendingPathComponent("manifest.json"))
        let ignored = try await call(intake.pending); try require((ignored["notices"] as? [Any])?.isEmpty == true, "App Group unpublished handoff remains invisible")
        try FileManager.default.moveItem(at: pending, to: outbox.appendingPathComponent(id))
        try await rejected("Missing shared bytes prevent acknowledgement/data loss") { _ = try await self.call(self.intake.pending) }
        try await rejected("Invalid acknowledgement cannot escape shared outbox") { _ = try await self.call(self.intake.acknowledge, ["id": "../outside"]) }
    }
    private func share(pdf: Bool) async {
        do {
            let bytes: Data, name: String
            if pdf { bytes = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 300, height: 200)).pdfData { context in context.beginPage(); (fixtureText as NSString).draw(at: CGPoint(x: 15, y: 30), withAttributes: [.font: UIFont.systemFont(ofSize: 12)]) }; name = "synthetic.pdf" }
            else { bytes = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 80)).pngData { context in UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 80)) }; name = "synthetic.png" }
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); let url = root.appendingPathComponent(name); try bytes.write(to: url)
            let controller = UIActivityViewController(activityItems: [fixtureText, url], applicationActivities: nil)
            controller.excludedActivityTypes = [.airDrop, .message, .mail, .copyToPasteboard, .print, .saveToCameraRoll, .assignToContact, .addToReadingList, .openInIBooks, .markupAsPDF]
            controller.popoverPresentationController?.sourceView = view; present(controller, animated: true)
        } catch { try? record(pdf ? "share-pdf" : "share-image", passed: false, error: error.localizedDescription) }
    }
    private func checkShare(pdf: Bool) async throws {
        let first = try await call(intake.pending), again = try await call(intake.pending)
        guard let notice = (first["notices"] as? [[String: Any]])?.first, let id = notice["id"] as? String, let file = (notice["files"] as? [[String: String]])?.first, let base64 = file["base64"], let bytes = Data(base64Encoded: base64) else { throw Failure.assertion("The real Share extension has not produced a complete handoff") }
        try require(notice["text"] as? String == fixtureText, "Actual Share extension preserves synthetic text")
        try require((again["notices"] as? [[String: Any]])?.first?["id"] as? String == id, "Share handoff persists until explicit acknowledgement")
        if pdf { let original = try Data(contentsOf: root.appendingPathComponent("synthetic.pdf")); try require(file["type"] == "application/pdf" && bytes == original, "App Group transfers exact PDF bytes") }
        else { let image = UIImage(data: bytes), original = UIImage(data: try Data(contentsOf: root.appendingPathComponent("synthetic.png"))); try require(file["type"] == "image/jpeg" && original != nil && image?.cgImage?.width == original?.cgImage?.width && image?.cgImage?.height == original?.cgImage?.height, "Actual Share extension converts image to readable JPEG without changing dimensions") }
        _ = try await call(intake.acknowledge, ["id": id]); let empty = try await call(intake.pending); try require((empty["notices"] as? [Any])?.isEmpty == true, "Acknowledgement removes only the received notice")
    }
}
