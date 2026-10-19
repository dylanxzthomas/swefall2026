import Foundation
import EventKit
import CryptoKit
import Capacitor

// EventKit proves the local phone calendar state, not synchronization to iCloud.
@objc(DaymarkCalendarPlugin)
public class DaymarkCalendarPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DaymarkCalendarPlugin"
    public let jsName = "DaymarkCalendar"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "installation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reconcile", returnType: CAPPluginReturnPromise)
    ]
    private let store = EKEventStore()
    private let queue = DispatchQueue(label: "daymark.calendar")
    private struct Operation: Codable {
        let operationId: String, approvalHash: String, calendarId: String, operation: String
        let title: String, location: String, notes: String, timezone: String
        let start: Double, end: Double, allDay: Bool
        let eventId: String?, expectedFingerprint: String?
    }
    private struct Attempt: Codable {
        let operationHash: String
        var eventId: String?
        var verifiedAt: Double?
        var fingerprint: String?
    }
    private enum Failure: LocalizedError {
        case blocked(String)
        var errorDescription: String? { if case let .blocked(message) = self { return message }; return nil }
    }
    private func permission() -> String {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) { if status == .fullAccess { return "granted" } }
        else if status == .authorized { return "granted" }
        return status == .notDetermined ? "prompt" : "denied"
    }
    private func requireAccess() throws {
        guard permission() == "granted" else { throw Failure.blocked("Allow full Calendar access in iPhone Settings to save and verify events.") }
    }
    private func calendars() -> [[String: String]] {
        guard permission() == "granted" else { return [] }
        return store.calendars(for: .event).filter { $0.allowsContentModifications }.map { ["id": $0.calendarIdentifier, "title": $0.title, "account": $0.source.title] }
    }
    @objc func status(_ call: CAPPluginCall) {
        queue.async { call.resolve(["permission": self.permission(), "calendars": self.calendars()]) }
    }
    @objc func connect(_ call: CAPPluginCall) {
        let completion: (Bool, Error?) -> Void = { _, error in
            self.queue.async {
                if error != nil { call.reject("Calendar permission could not be requested. Check iPhone Settings."); return }
                self.store.reset()
                call.resolve(["permission": self.permission(), "calendars": self.calendars()])
            }
        }
        DispatchQueue.main.async {
            if #available(iOS 17.0, *) { self.store.requestFullAccessToEvents(completion: completion) }
            else { self.store.requestAccess(to: .event, completion: completion) }
        }
    }
    private func digest(_ value: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func snapshot(_ event: EKEvent) throws -> [String: Any] {
        var data: [String: Any] = ["eventId": event.eventIdentifier ?? "", "calendarId": event.calendar.calendarIdentifier, "title": event.title ?? "", "location": event.location ?? "", "notes": event.notes ?? "", "start": event.startDate.timeIntervalSince1970 * 1000, "end": event.endDate.timeIntervalSince1970 * 1000, "allDay": event.isAllDay, "timezone": event.timeZone?.identifier ?? TimeZone.current.identifier]
        data["fingerprint"] = try digest(data.merging(["modified": event.lastModifiedDate?.timeIntervalSince1970 ?? 0, "url": event.url?.absoluteString ?? "", "recurring": event.hasRecurrenceRules, "hasGuests": !(event.attendees?.isEmpty ?? true) || event.organizer != nil]) { _, new in new })
        return data
    }
    @objc func read(_ call: CAPPluginCall) {
        queue.async {
            do {
                try self.requireAccess(); self.store.reset()
                guard let id = call.getString("eventId"), let calendarId = call.getString("calendarId"), let event = self.store.event(withIdentifier: id), event.calendar.calendarIdentifier == calendarId, event.url?.scheme == "daymark", event.url?.host == "calendar", (event.attendees?.isEmpty ?? true), event.organizer == nil, !event.hasRecurrenceRules else { throw Failure.blocked("This Daymark calendar event is no longer available. Check Apple Calendar before making another change.") }
                call.resolve(["event": try self.snapshot(event)])
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func installation(_ call: CAPPluginCall) {
        queue.async {
            do {
                let url = try self.journalURL(String(repeating: "0", count: 64)).deletingLastPathComponent().appendingPathComponent("installation.json")
                if FileManager.default.fileExists(atPath: url.path) {
                    let id = try JSONDecoder().decode(String.self, from: Data(contentsOf: url))
                    guard UUID(uuidString: id) != nil else { throw Failure.blocked("The calendar installation identity is unavailable.") }
                    call.resolve(["deviceId": id]); return
                }
                let id = UUID().uuidString
                try JSONEncoder().encode(id).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                call.resolve(["deviceId": id])
            } catch { call.reject("The calendar installation identity could not be restored. Unlock this iPhone and try again.") }
        }
    }
    private func journalURL(_ key: String) throws -> URL {
        guard key.count == 64, key.allSatisfy({ $0.isHexDigit }) else { throw Failure.blocked("Invalid calendar operation.") }
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("DaymarkCalendar", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var excluded = root; var resource = URLResourceValues(); resource.isExcludedFromBackup = true; try excluded.setResourceValues(resource)
        return root.appendingPathComponent(key + ".json")
    }
    private func persist(_ attempt: Attempt, at url: URL) throws {
        try JSONEncoder().encode(attempt).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func marker(_ operation: Operation) -> URL { URL(string: "daymark://calendar/" + operation.operationId)! }
    private func find(_ operation: Operation, calendar: EKCalendar, attempt: Attempt) -> EKEvent? {
        guard let calendar = store.calendar(withIdentifier: operation.calendarId) else { return nil }
        let predicate = store.predicateForEvents(withStart: Date(timeIntervalSince1970: operation.start / 1000 - 86400), end: Date(timeIntervalSince1970: operation.end / 1000 + 86400), calendars: [calendar])
        var candidates = store.events(matching: predicate).filter { $0.url == marker(operation) }
        if let id = attempt.eventId ?? operation.eventId, let event = store.event(withIdentifier: id), event.calendar.calendarIdentifier == operation.calendarId, !candidates.contains(where: { $0.eventIdentifier == event.eventIdentifier }) { candidates.append(event) }
        // Duplicated markers are ambiguous; never choose one event and call the operation verified.
        return candidates.count == 1 ? candidates[0] : nil
    }
    private func day(_ date: Date, _ zone: TimeZone) -> DateComponents {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        return calendar.dateComponents([.year, .month, .day], from: date)
    }
    private func localAllDay(_ milliseconds: Double, _ timezone: String) -> Date {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        return calendar.date(from: day(Date(timeIntervalSince1970: milliseconds / 1000), TimeZone(identifier: timezone)!))!
    }
    private func matches(_ event: EKEvent, _ operation: Operation) -> Bool {
        let exactTimes: Bool
        if operation.allDay {
            let actualZone = event.timeZone ?? .current, approvedZone = TimeZone(identifier: operation.timezone)!
            exactTimes = day(event.startDate, actualZone) == day(Date(timeIntervalSince1970: operation.start / 1000), approvedZone) && day(event.endDate, actualZone) == day(Date(timeIntervalSince1970: operation.end / 1000), approvedZone)
        } else { exactTimes = abs(event.startDate.timeIntervalSince1970 * 1000 - operation.start) < 1 && abs(event.endDate.timeIntervalSince1970 * 1000 - operation.end) < 1 }
        return event.calendar.calendarIdentifier == operation.calendarId && event.url == marker(operation) && (event.title ?? "") == operation.title && (event.location ?? "") == operation.location && (event.notes ?? "") == operation.notes && event.isAllDay == operation.allDay && exactTimes && !event.hasRecurrenceRules && (event.attendees?.isEmpty ?? true) && event.organizer == nil
    }
    private func verified(_ attempt: Attempt) -> [String: Any] {
        var result: [String: Any] = ["status": "verified", "verifiedAt": attempt.verifiedAt!]
        if let eventId = attempt.eventId { result["eventId"] = eventId }
        if let fingerprint = attempt.fingerprint { result["fingerprint"] = fingerprint }
        return result
    }
    private func recover(_ operation: Operation, calendar: EKCalendar, attempt: Attempt, url: URL) throws -> [String: Any] {
        if attempt.verifiedAt != nil { return verified(attempt) }
        store.reset()
        // A missing identifier alone cannot prove deletion: EventKit identifiers can change on sync.
        guard operation.operation != "delete", let event = find(operation, calendar: calendar, attempt: attempt), matches(event, operation) else {
            return ["status": "uncertain", "message": "The Apple Calendar result is unconfirmed. Check the calendar; Daymark will not repeat this write automatically."]
        }
        var saved = attempt; saved.eventId = event.eventIdentifier; saved.fingerprint = try snapshot(event)["fingerprint"] as? String; saved.verifiedAt = Date().timeIntervalSince1970 * 1000
        try persist(saved, at: url); return verified(saved)
    }
    private func perform(_ call: CAPPluginCall, readOnly: Bool) {
        queue.async {
            do {
                try self.requireAccess(); self.store.reset()
                guard let raw = call.getObject("operation") else { throw Failure.blocked("Missing approved calendar operation.") }
                let operation = try JSONDecoder().decode(Operation.self, from: JSONSerialization.data(withJSONObject: raw))
                guard ["save", "delete"].contains(operation.operation), operation.end > operation.start, operation.end - operation.start < 366 * 86400000, TimeZone(identifier: operation.timezone) != nil, !operation.title.isEmpty, operation.title.count <= 300, operation.notes.count <= 2000, let calendar = self.store.calendar(withIdentifier: operation.calendarId), calendar.allowsContentModifications else { throw Failure.blocked("The approved calendar is no longer writable, or the event details need review.") }
                let url = try self.journalURL(operation.operationId), operationHash = try self.digest(raw)
                if FileManager.default.fileExists(atPath: url.path) {
                    let attempt = try JSONDecoder().decode(Attempt.self, from: Data(contentsOf: url))
                    guard attempt.operationHash == operationHash else { throw Failure.blocked("This calendar approval changed. Review the latest draft.") }
                    call.resolve(try self.recover(operation, calendar: calendar, attempt: attempt, url: url)); return
                }
                if readOnly { call.resolve(try self.recover(operation, calendar: calendar, attempt: Attempt(operationHash: operationHash, eventId: operation.eventId), url: url)); return }
                var event: EKEvent
                if let id = operation.eventId {
                    guard let existing = self.store.event(withIdentifier: id), existing.calendar.calendarIdentifier == operation.calendarId, existing.url?.scheme == "daymark", existing.url?.host == "calendar", !existing.hasRecurrenceRules, (existing.attendees?.isEmpty ?? true), existing.organizer == nil, let expected = operation.expectedFingerprint, try self.snapshot(existing)["fingerprint"] as? String == expected else { call.resolve(["status": "review", "message": "The original Apple Calendar event changed. Refresh its details and review again."]); return }
                    event = existing
                } else {
                    guard operation.operation != "delete" else { throw Failure.blocked("Choose an existing Daymark event to remove.") }
                    event = EKEvent(eventStore: self.store); event.calendar = calendar; event.alarms = []
                }
                var attempt = Attempt(operationHash: operationHash, eventId: operation.eventId)
                // Persist before entering EventKit: any interruption from here is reconciled, never replayed.
                try self.persist(attempt, at: url)
                do {
                    // Recheck after the journal fsync. EventKit has no compare-and-swap API;
                    // a remaining cross-app race still needs physical-device acceptance testing.
                    if let id = operation.eventId {
                        self.store.reset()
                        guard let latest = self.store.event(withIdentifier: id), latest.calendar.calendarIdentifier == operation.calendarId, try self.snapshot(latest)["fingerprint"] as? String == operation.expectedFingerprint else { call.resolve(["status": "review", "message": "The original Apple Calendar event changed just before saving. Refresh it and review again."]); return }
                        event = latest
                    }
                    if operation.operation == "delete" {
                        let originalMarker = event.url, originalStart = event.startDate!, originalEnd = event.endDate!
                        try self.store.remove(event, span: .thisEvent, commit: true)
                        self.store.reset()
                        guard let refreshedCalendar = self.store.calendar(withIdentifier: operation.calendarId) else { call.resolve(["status": "uncertain", "message": "The calendar disappeared before removal could be verified."]); return }
                        let remaining = self.store.events(matching: self.store.predicateForEvents(withStart: originalStart.addingTimeInterval(-86400), end: originalEnd.addingTimeInterval(86400), calendars: [refreshedCalendar])).filter { $0.url == originalMarker }
                        guard let id = operation.eventId, self.store.event(withIdentifier: id) == nil, remaining.isEmpty else { call.resolve(["status": "uncertain", "message": "Calendar removal could not be confirmed."]); return }
                        attempt.verifiedAt = Date().timeIntervalSince1970 * 1000
                    } else {
                        event.title = operation.title; event.location = operation.location; event.notes = operation.notes
                        event.isAllDay = operation.allDay
                        event.timeZone = operation.allDay ? nil : TimeZone(identifier: operation.timezone)
                        event.startDate = operation.allDay ? self.localAllDay(operation.start, operation.timezone) : Date(timeIntervalSince1970: operation.start / 1000)
                        event.endDate = operation.allDay ? self.localAllDay(operation.end, operation.timezone) : Date(timeIntervalSince1970: operation.end / 1000)
                        event.url = self.marker(operation)
                        try self.store.save(event, span: .thisEvent, commit: true)
                        attempt.eventId = event.eventIdentifier
                        try self.persist(attempt, at: url)
                        call.resolve(try self.recover(operation, calendar: calendar, attempt: attempt, url: url)); return
                    }
                    try self.persist(attempt, at: url); call.resolve(self.verified(attempt))
                } catch {
                    call.resolve(["status": "uncertain", "message": "Apple Calendar did not return a verified result. Check the calendar before making another change."])
                }
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func execute(_ call: CAPPluginCall) { perform(call, readOnly: false) }
    @objc func reconcile(_ call: CAPPluginCall) { perform(call, readOnly: true) }
}
