import UIKit
import UniformTypeIdentifiers
import ImageIO

final class ShareViewController: UIViewController {
    private let status = UILabel()
    private let save = UIButton(type: .system)
    private let groupID = "group.com.dylanxzthomas.wren.daymark"
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel(); title.text = "Share with Daymark"; title.font = .preferredFont(forTextStyle: .title2)
        status.text = "Save this notice on your phone, then open Daymark to review and upload it."; status.numberOfLines = 0; status.font = .preferredFont(forTextStyle: .body)
        save.setTitle("Save on this phone", for: .normal); save.addTarget(self, action: #selector(saveNotice), for: .touchUpInside)
        let cancel = UIButton(type: .system); cancel.setTitle("Cancel", for: .normal); cancel.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, status, save, cancel]); stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20), stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 30), save.heightAnchor.constraint(greaterThanOrEqualToConstant: 44), cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)])
    }
    @objc private func close() { extensionContext?.completeRequest(returningItems: nil) }
    @objc private func saveNotice() {
        save.isEnabled = false
        Task { @MainActor in
            var working: URL?
            do {
                guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID) else { throw IntakeError.message("Enable the Daymark App Group for both app targets in Xcode.") }
                let outbox = root.appendingPathComponent("DaymarkOutbox", isDirectory: true)
                try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
                let id = UUID().uuidString
                let folder = outbox.appendingPathComponent("pending-" + id, isDirectory: true); working = folder
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                var text: [String] = []; var files: [[String: String]] = []; var total = 0; var pdfs = 0
                let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
                for provider in providers {
                    if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) || provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                        let pdf = provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier)
                        let type = pdf ? UTType.pdf.identifier : UTType.image.identifier
                        let raw = try await data(provider, type)
                        guard raw.count <= 10 * 1024 * 1024 else { throw IntakeError.message("Share files up to 10 MB.") }
                        if !pdf, let source = CGImageSourceCreateWithData(raw as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int, width * height > 12000000 { throw IntakeError.message("Share a smaller image, up to 12 megapixels.") }
                        // UIImage converts HEIC to a provider-supported image without changing the source in Photos.
                        let bytes: Data
                        if pdf { bytes = raw; pdfs += 1 } else { guard let image = UIImage(data: raw), let jpeg = image.jpegData(compressionQuality: 0.9) else { throw IntakeError.message("This image could not be read.") }; bytes = jpeg }
                        total += bytes.count
                        guard files.count < 5, total <= 10 * 1024 * 1024 else { throw IntakeError.message("Share up to five images or one PDF, 10 MB total.") }
                        let name = UUID().uuidString + (pdf ? ".pdf" : ".jpg")
                        try bytes.write(to: folder.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                        files.append(["name": name, "type": pdf ? "application/pdf" : "image/jpeg"])
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                        text.append(try await string(provider, UTType.plainText.identifier))
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                        text.append(try await string(provider, UTType.url.identifier))
                    }
                }
                let notice = text.joined(separator: "\n")
                guard notice.count <= 20000, (!notice.isEmpty || !files.isEmpty), pdfs == 0 || files.count == 1 else { throw IntakeError.message("Share text up to 20,000 characters, five images, or one PDF.") }
                let manifest: [String: Any] = ["id": id, "text": notice, "files": files]
                try JSONSerialization.data(withJSONObject: manifest).write(to: folder.appendingPathComponent("manifest.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                try FileManager.default.moveItem(at: folder, to: outbox.appendingPathComponent(id, isDirectory: true)); working = nil
                status.text = "Saved on this phone—open Daymark to upload. Nothing has been sent or added to your calendar."
                save.setTitle("Saved", for: .normal)
            } catch {
                if let folder = working { try? FileManager.default.removeItem(at: folder) }
                status.text = (error as? IntakeError)?.description ?? "Could not save this notice. Try sharing it again."
                save.isEnabled = true
            }
        }
    }
    private func data(_ provider: NSItemProvider, _ type: String) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in if let data { continuation.resume(returning: data) } else { continuation.resume(throwing: error ?? IntakeError.message("File unavailable.")) } } }
    }
    private func string(_ provider: NSItemProvider, _ type: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in provider.loadItem(forTypeIdentifier: type) { item, error in if let text = item as? String { continuation.resume(returning: text) } else if let url = item as? URL { continuation.resume(returning: url.absoluteString) } else { continuation.resume(throwing: error ?? IntakeError.message("Text unavailable.")) } } }
    }
    enum IntakeError: Error { case message(String); var description: String { switch self { case .message(let value): return value } } }
}
