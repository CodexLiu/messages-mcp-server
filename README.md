# Messages MCP Server

Local MCP server for macOS Messages.

It uses:

- AppleScript for sending iMessages
- `Contacts.framework` through a Swift helper for contact lookup and name resolution
- `~/Library/Messages/chat.db` for inbox and history reads

## What It Can Do

- Search contacts by name, phone number, or email
- Resolve names onto chats and message senders
- List recent chats with last message previews
- Read messages from a specific conversation
- Show the latest messages across all chats
- Search messages by content
- Show unread chats
- Resolve a person into matching contacts, chats, and sendable identifiers
- Send iMessages through the local Messages app
- Expose read-only Messages database inspection tools for debugging

## Manual Setup

This server needs macOS privacy permissions. Without them, chat reads or contact lookup will fail.

### 1. Sign in to Messages

Open the Messages app and make sure the Mac is signed into the account you want to use.

### 2. Grant Full Disk Access

This is required for reading `~/Library/Messages/chat.db`.

1. Open `System Settings`
2. Go to `Privacy & Security`
3. Open `Full Disk Access`
4. Enable Full Disk Access for the app or process that runs this MCP server

Common cases:

- `Codex`
- `Terminal`
- `iTerm`

If it is not listed:

1. Click `+`
2. Add the app you use to run the server
3. Toggle it on

After enabling it, fully quit and reopen the app.

### 3. Grant Contacts Access

This is required for contact search and name resolution.

1. Open `System Settings`
2. Go to `Privacy & Security`
3. Open `Contacts`
4. Enable Contacts access for the app or process that runs this MCP server

After enabling it, fully quit and reopen the app.

### 4. Grant Automation Access for Sending

This is required because sending goes through AppleScript and the Messages app.

The first time a send action runs, macOS may prompt for automation permissions. Approve the prompt so the host app can control Messages.

If you need to review it manually:

1. Open `System Settings`
2. Go to `Privacy & Security`
3. Open `Automation`
4. Make sure the host app is allowed to control `Messages`

## Install / Run

```bash
npm install
npm run build
```

Configure your MCP host to run:

```bash
node /absolute/path/to/build/index.js
```

## Notes

- Reading chats depends on local Messages database access
- Contact lookup does not require the Contacts app to be open
- Sending messages still depends on the Messages app and AppleScript permissions
- The database tools are read-only and intended for debugging or advanced inspection

## Development

```bash
npm install
npm run build
```

## Architecture

- Contacts are resolved through `scripts/contacts.swift`
- Message and chat history come from `~/Library/Messages/chat.db`
- Sending still goes through AppleScript in the Messages app
