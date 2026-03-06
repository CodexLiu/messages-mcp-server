# Messages MCP Server

Local MCP server for macOS Messages.

It uses:

- AppleScript for contact lookup and sending iMessages
- `~/Library/Messages/chat.db` for inbox and history reads

## Tools

- `search_contacts`
- `send_imessage`
- `list_chats`
- `read_chat`
- `get_latest_messages`
- `search_messages`
- `get_messages_db_schema`
- `query_messages_db`

## Requirements

- macOS
- Full Disk Access for the host process that reads `~/Library/Messages/chat.db`
- Messages app signed in

## Development

```bash
npm install
npm run build
```
