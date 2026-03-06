#!/usr/bin/env swift

import Contacts
import Foundation

struct ContactRecord: Codable {
    let name: String
    let phones: [String]
    let emails: [String]
}

enum ContactsHelperError: Error, LocalizedError {
    case usage
    case accessDenied

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: contacts.swift <all|search> [query]"
        case .accessDenied:
            return "Contacts access denied"
        }
    }
}

func ensureAccess(store: CNContactStore) throws {
    let status = CNContactStore.authorizationStatus(for: .contacts)
    switch status {
    case .authorized:
        return
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        store.requestAccess(for: .contacts) { allowed, _ in
            granted = allowed
            semaphore.signal()
        }
        semaphore.wait()
        if granted { return }
        throw ContactsHelperError.accessDenied
    default:
        throw ContactsHelperError.accessDenied
    }
}

func loadContacts() throws -> [ContactRecord] {
    let store = CNContactStore()
    try ensureAccess(store: store)

    let keys: [CNKeyDescriptor] = [
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
    ]

    var records: [ContactRecord] = []
    let request = CNContactFetchRequest(keysToFetch: keys)

    try store.enumerateContacts(with: request) { contact, _ in
        let name = CNContactFormatter.string(from: contact, style: .fullName)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? [contact.givenName, contact.familyName].joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)

        let phones = contact.phoneNumbers.map { $0.value.stringValue }
        let emails = contact.emailAddresses.map { String($0.value) }

        records.append(
            ContactRecord(
                name: name.isEmpty ? "(No Name)" : name,
                phones: phones,
                emails: emails
            )
        )
    }

    return records
}

func filterContacts(_ contacts: [ContactRecord], query: String) -> [ContactRecord] {
    let needle = query.lowercased()
    return contacts.filter { contact in
        if contact.name.lowercased().contains(needle) { return true }
        if contact.phones.contains(where: { $0.lowercased().contains(needle) }) { return true }
        if contact.emails.contains(where: { $0.lowercased().contains(needle) }) { return true }
        return false
    }
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let command = args.first else {
        throw ContactsHelperError.usage
    }

    let contacts = try loadContacts()
    let output: [ContactRecord]

    switch command {
    case "all":
        output = contacts
    case "search":
        guard args.count >= 2 else {
            throw ContactsHelperError.usage
        }
        output = filterContacts(contacts, query: args.dropFirst().joined(separator: " "))
    default:
        throw ContactsHelperError.usage
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(output)
    FileHandle.standardOutput.write(data)
} catch {
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}
