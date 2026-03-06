#!/usr/bin/env node

import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);
const APPLE_EPOCH_MS = 978307200000;
const MESSAGES_DB_PATH = `${os.homedir()}/Library/Messages/chat.db`;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTACTS_HELPER_PATH = path.join(PROJECT_ROOT, "scripts", "contacts.swift");

type ChatSummaryRow = {
  chat_id: number;
  chat_guid: string;
  chat_identifier: string | null;
  display_name: string | null;
  service_name: string | null;
  is_archived: number;
  participant_ids: string | null;
  participant_count: number;
  message_count: number;
  unread_count: number;
  last_message_date: number | null;
  last_message_text: string | null;
  last_message_attributed_hex: string | null;
};

type MessageRow = {
  message_id: number;
  message_guid: string;
  chat_id: number;
  chat_guid: string;
  chat_identifier: string | null;
  chat_display_name: string | null;
  service_name: string | null;
  sender: string | null;
  text: string | null;
  attributed_hex: string | null;
  is_from_me: number;
  date: number | null;
  date_read: number | null;
  date_delivered: number | null;
  cache_has_attachments: number;
};

type ContactRecord = {
  name: string;
  phones: string[];
  emails: string[];
};

type ResolvedParticipant = {
  identifier: string;
  contactName: string | null;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

async function runAppleScript(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return stdout.trim();
  } catch (error) {
    throw new Error(`AppleScript error: ${getErrorMessage(error)}`);
  }
}

async function ensureAppRunning(appName: string): Promise<void> {
  const script = `
    tell application "${escapeAppleScriptString(appName)}"
      launch
    end tell
  `;

  await runAppleScript(script);
}

async function runSqliteJson<T>(query: string): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", MESSAGES_DB_PATH, query]);
    return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
  } catch (error) {
    throw new Error(`sqlite error: ${getErrorMessage(error)}`);
  }
}

async function runSqliteText(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("sqlite3", [MESSAGES_DB_PATH, ...args]);
    return stdout.trim();
  } catch (error) {
    throw new Error(`sqlite error: ${getErrorMessage(error)}`);
  }
}

async function runContactsHelper(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("swift", [CONTACTS_HELPER_PATH, ...args]);
    return stdout.trim();
  } catch (error) {
    throw new Error(`contacts helper error: ${getErrorMessage(error)}`);
  }
}

function normalizeLimit(input: unknown, fallback = 20, max = 100): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.trunc(value), max);
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits || trimmed;
}

function appleTimestampToIso(value: number | null | undefined): string | null {
  if (!value) return null;
  return new Date(Math.trunc(value / 1_000_000) + APPLE_EPOCH_MS).toISOString();
}

function decodeAttributedBodyHex(hex: string | null | undefined): string | null {
  if (!hex) return null;

  const text = Buffer.from(hex, "hex").toString("utf8");
  const values = text
    .match(/[\x20-\x7e]{1,}/g)
    ?.map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => /[A-Za-z0-9]/.test(part))
    .filter((part) => part.length >= 2)
    .filter((part) => !/^[+*@]+$/.test(part))
    .filter((part) => part !== "iI")
    .filter(
      (part) =>
        ![
          "streamtype",
          "streamtyped",
          "NSAttributedString",
          "NSObject",
          "NSString",
          "NSDictionary",
          "NSNumber",
          "NSValue",
          "__kIMMessagePartAttributeName",
        ].includes(part)
    );

  if (!values?.length) return null;
  values.sort((a, b) => a.length - b.length);
  return values[0] ?? null;
}

function getMessageText(text: string | null, attributedHex: string | null): string | null {
  const plain = text?.trim();
  return plain || decodeAttributedBodyHex(attributedHex);
}

async function getAllContacts(): Promise<ContactRecord[]> {
  return JSON.parse(await runContactsHelper(["all"])) as ContactRecord[];
}

async function searchContacts(query: string): Promise<ContactRecord[]> {
  return JSON.parse(await runContactsHelper(["search", query])) as ContactRecord[];
}

async function buildContactIndex(): Promise<Map<string, string>> {
  const contacts = await getAllContacts();
  const index = new Map<string, string>();

  for (const contact of contacts) {
    for (const phone of contact.phones) {
      const normalized = normalizeIdentifier(phone);
      if (normalized) index.set(normalized, contact.name);
    }

    for (const email of contact.emails) {
      const normalized = normalizeIdentifier(email);
      if (normalized) index.set(normalized, contact.name);
    }
  }

  return index;
}

function resolveParticipants(
  identifiers: string[],
  contactIndex: Map<string, string>
): ResolvedParticipant[] {
  return identifiers.map((identifier) => ({
    identifier,
    contactName: contactIndex.get(normalizeIdentifier(identifier)) ?? null,
  }));
}

function getPreferredChatName(
  displayName: string | null,
  participants: ResolvedParticipant[]
): string | null {
  if (displayName?.trim()) return displayName.trim();

  const names = participants
    .map((participant) => participant.contactName)
    .filter((name): name is string => Boolean(name));

  if (names.length === 1) return names[0];
  if (names.length > 1) return names.join(", ");
  return null;
}

function formatChatSummary(row: ChatSummaryRow, contactIndex: Map<string, string>) {
  const participantIds = row.participant_ids ? row.participant_ids.split(",").filter(Boolean) : [];
  const participants = resolveParticipants(participantIds, contactIndex);

  return {
    chatId: row.chat_id,
    chatGuid: row.chat_guid,
    chatIdentifier: row.chat_identifier,
    displayName: row.display_name || null,
    preferredName: getPreferredChatName(row.display_name, participants),
    service: row.service_name || null,
    isArchived: Boolean(row.is_archived),
    participantCount: row.participant_count,
    participants,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    lastMessageAt: appleTimestampToIso(row.last_message_date),
    lastMessageText: getMessageText(row.last_message_text, row.last_message_attributed_hex),
  };
}

function formatMessage(row: MessageRow, contactIndex: Map<string, string>) {
  const senderContactName = row.sender
    ? contactIndex.get(normalizeIdentifier(row.sender)) ?? null
    : null;

  return {
    messageId: row.message_id,
    messageGuid: row.message_guid,
    chatId: row.chat_id,
    chatGuid: row.chat_guid,
    chatIdentifier: row.chat_identifier,
    chatDisplayName: row.chat_display_name || null,
    chatPreferredName:
      row.chat_display_name?.trim() ||
      (row.chat_identifier
        ? contactIndex.get(normalizeIdentifier(row.chat_identifier)) ?? null
        : null),
    service: row.service_name || null,
    sender: row.sender,
    senderContactName,
    isFromMe: Boolean(row.is_from_me),
    text: getMessageText(row.text, row.attributed_hex),
    sentAt: appleTimestampToIso(row.date),
    deliveredAt: appleTimestampToIso(row.date_delivered),
    readAt: appleTimestampToIso(row.date_read),
    hasAttachments: Boolean(row.cache_has_attachments),
  };
}

async function listChats(limit: number, query: string, includeArchived: boolean) {
  const where: string[] = [];

  if (!includeArchived) {
    where.push("c.is_archived = 0");
  }

  if (query) {
    const q = escapeSqlString(query.toLowerCase());
    where.push(`(
      lower(coalesce(c.display_name, '')) like '%${q}%'
      or lower(coalesce(c.chat_identifier, '')) like '%${q}%'
      or exists (
        select 1
        from chat_handle_join chj2
        join handle h2 on h2.ROWID = chj2.handle_id
        where chj2.chat_id = c.ROWID
          and lower(h2.id) like '%${q}%'
      )
    )`);
  }

  const whereClause = where.length ? `where ${where.join(" and ")}` : "";

  const sql = `
    select
      c.ROWID as chat_id,
      c.guid as chat_guid,
      c.chat_identifier,
      c.display_name,
      c.service_name,
      c.is_archived,
      group_concat(distinct h.id) as participant_ids,
      count(distinct h.ROWID) as participant_count,
      count(distinct m.ROWID) as message_count,
      sum(
        case
          when m.is_from_me = 0 and m.date > coalesce(c.last_read_message_timestamp, 0)
          then 1 else 0
        end
      ) as unread_count,
      max(m.date) as last_message_date,
      (
        select m2.text
        from chat_message_join cmj2
        join message m2 on m2.ROWID = cmj2.message_id
        where cmj2.chat_id = c.ROWID
        order by m2.date desc
        limit 1
      ) as last_message_text,
      (
        select hex(m2.attributedBody)
        from chat_message_join cmj2
        join message m2 on m2.ROWID = cmj2.message_id
        where cmj2.chat_id = c.ROWID
        order by m2.date desc
        limit 1
      ) as last_message_attributed_hex
    from chat c
    join chat_message_join cmj on cmj.chat_id = c.ROWID
    join message m on m.ROWID = cmj.message_id
    left join chat_handle_join chj on chj.chat_id = c.ROWID
    left join handle h on h.ROWID = chj.handle_id
    ${whereClause}
    group by c.ROWID
    order by last_message_date desc
    limit ${limit};
  `;

  const [rows, contactIndex] = await Promise.all([
    runSqliteJson<ChatSummaryRow>(sql),
    buildContactIndex(),
  ]);

  return rows.map((row) => formatChatSummary(row, contactIndex));
}

async function readChat(limit: number, chatId: number | null, chatIdentifier: string | null) {
  const whereClause =
    chatId != null
      ? `c.ROWID = ${Math.trunc(chatId)}`
      : `c.chat_identifier = '${escapeSqlString(chatIdentifier ?? "")}'`;

  const sql = `
    select
      m.ROWID as message_id,
      m.guid as message_guid,
      c.ROWID as chat_id,
      c.guid as chat_guid,
      c.chat_identifier,
      c.display_name as chat_display_name,
      c.service_name,
      h.id as sender,
      m.text,
      hex(m.attributedBody) as attributed_hex,
      m.is_from_me,
      m.date,
      m.date_read,
      m.date_delivered,
      m.cache_has_attachments
    from chat c
    join chat_message_join cmj on cmj.chat_id = c.ROWID
    join message m on m.ROWID = cmj.message_id
    left join handle h on h.ROWID = m.handle_id
    where ${whereClause}
    order by m.date desc
    limit ${limit};
  `;

  const [rows, contactIndex] = await Promise.all([
    runSqliteJson<MessageRow>(sql),
    buildContactIndex(),
  ]);

  return rows.reverse().map((row) => formatMessage(row, contactIndex));
}

async function getLatestMessages(limit: number) {
  const sql = `
    select
      m.ROWID as message_id,
      m.guid as message_guid,
      c.ROWID as chat_id,
      c.guid as chat_guid,
      c.chat_identifier,
      c.display_name as chat_display_name,
      c.service_name,
      h.id as sender,
      m.text,
      hex(m.attributedBody) as attributed_hex,
      m.is_from_me,
      m.date,
      m.date_read,
      m.date_delivered,
      m.cache_has_attachments
    from message m
    join chat_message_join cmj on cmj.message_id = m.ROWID
    join chat c on c.ROWID = cmj.chat_id
    left join handle h on h.ROWID = m.handle_id
    order by m.date desc
    limit ${limit};
  `;

  const [rows, contactIndex] = await Promise.all([
    runSqliteJson<MessageRow>(sql),
    buildContactIndex(),
  ]);

  return rows.map((row) => formatMessage(row, contactIndex));
}

async function searchMessages(query: string, limit: number) {
  const messages = await getLatestMessages(Math.max(limit * 10, 200));
  const q = query.toLowerCase();

  return messages
    .filter((message) => {
      const text = (message.text ?? "").toLowerCase();
      const sender = (message.sender ?? "").toLowerCase();
      const identifier = (message.chatIdentifier ?? "").toLowerCase();
      const displayName = (message.chatDisplayName ?? "").toLowerCase();
      return (
        text.includes(q) ||
        sender.includes(q) ||
        identifier.includes(q) ||
        displayName.includes(q)
      );
    })
    .slice(0, limit);
}

function ensureReadOnlySql(sql: string): string {
  const normalized = sql.trim().replace(/;+$/, "");
  const lowered = normalized.toLowerCase();

  if (!normalized) {
    throw new Error("sql is required");
  }

  if (!/^(select|with|pragma table_info|pragma index_list|pragma index_info|explain)/i.test(normalized)) {
    throw new Error("Only read-only SELECT, WITH, EXPLAIN, and schema PRAGMA queries are allowed");
  }

  if (/\b(insert|update|delete|drop|alter|create|attach|detach|replace|vacuum|reindex|analyze)\b/i.test(lowered)) {
    throw new Error("Mutating SQL is not allowed");
  }

  return normalized;
}

async function getDbSchema(table?: string | null) {
  if (table) {
    const safeTable = table.replace(/[^A-Za-z0-9_]/g, "");
    if (!safeTable) {
      throw new Error("table must contain letters, numbers, or underscores");
    }

    return runSqliteText([`.schema ${safeTable}`]);
  }

  return runSqliteText([".schema"]);
}

async function queryMessagesDb(sql: string) {
  return runSqliteText(["-json", ensureReadOnlySql(sql)]);
}

const server = new Server(
  {
    name: "messages-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_contacts",
      description: "Search contacts by name, phone, or email",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "send_imessage",
      description: "Send an iMessage using the local Messages app",
      inputSchema: {
        type: "object",
        properties: {
          recipient: { type: "string" },
          message: { type: "string" },
        },
        required: ["recipient", "message"],
      },
    },
    {
      name: "list_chats",
      description: "List recent chats from the local Messages database",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          query: { type: "string" },
          includeArchived: { type: "boolean" },
        },
      },
    },
    {
      name: "read_chat",
      description: "Read messages from a chat by chatId or chatIdentifier",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "number" },
          chatIdentifier: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "get_latest_messages",
      description: "Get a global latest-messages feed across chats",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
        },
      },
    },
    {
      name: "search_messages",
      description: "Search recent messages by text, sender, or chat identifier",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_messages_db_schema",
      description: "Inspect the Messages sqlite schema, optionally for one table",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string" },
        },
      },
    },
    {
      name: "query_messages_db",
      description: "Run a read-only SQL query against the local Messages database",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" },
        },
        required: ["sql"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "search_contacts": {
      const query = String(request.params.arguments?.query ?? "").toLowerCase();
      try {
        return {
          content: [{ type: "text", text: JSON.stringify(await searchContacts(query)) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Search failed: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }

    case "send_imessage": {
      const recipient = String(request.params.arguments?.recipient ?? "").trim();
      const message = String(request.params.arguments?.message ?? "").trim();

      if (!recipient || !message) {
        throw new Error("recipient and message are required");
      }

      const escapedMessage = message.replace(/"/g, '\\"');
      await ensureAppRunning("Messages");
      const script = `
        tell application "Messages"
          send "${escapedMessage}" to buddy "${recipient}" of (service 1 whose service type = iMessage)
        end tell
      `;

      try {
        await runAppleScript(script);
        return {
          content: [{ type: "text", text: `Message sent successfully to ${recipient}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to send message: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }

    case "list_chats": {
      try {
        const limit = normalizeLimit(request.params.arguments?.limit, 20, 100);
        const query = String(request.params.arguments?.query ?? "").trim();
        const includeArchived = Boolean(request.params.arguments?.includeArchived);
        return {
          content: [{ type: "text", text: JSON.stringify(await listChats(limit, query, includeArchived)) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Chat listing failed: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }

    case "read_chat": {
      const chatIdRaw = request.params.arguments?.chatId;
      const chatIdentifier = String(request.params.arguments?.chatIdentifier ?? "").trim();
      const chatId = chatIdRaw == null ? null : Number(chatIdRaw);

      if (chatId == null && !chatIdentifier) {
        throw new Error("chatId or chatIdentifier is required");
      }

      if (chatIdRaw != null && !Number.isFinite(chatId)) {
        throw new Error("chatId must be numeric");
      }

      try {
        const limit = normalizeLimit(request.params.arguments?.limit, 20, 100);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(await readChat(limit, chatId, chatIdentifier || null)),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Chat read failed: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }

    case "get_latest_messages": {
      try {
        const limit = normalizeLimit(request.params.arguments?.limit, 20, 100);
        return {
          content: [{ type: "text", text: JSON.stringify(await getLatestMessages(limit)) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Latest messages failed: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }

    case "search_messages": {
      const query = String(request.params.arguments?.query ?? "").trim();
      if (!query) {
        throw new Error("query is required");
      }

      try {
        const limit = normalizeLimit(request.params.arguments?.limit, 20, 100);
        return {
          content: [{ type: "text", text: JSON.stringify(await searchMessages(query, limit)) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Message search failed: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }

    case "get_messages_db_schema": {
      try {
        const table = String(request.params.arguments?.table ?? "").trim() || null;
        return {
          content: [{ type: "text", text: await getDbSchema(table) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Schema lookup failed: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }

    case "query_messages_db": {
      const sql = String(request.params.arguments?.sql ?? "").trim();

      try {
        return {
          content: [{ type: "text", text: await queryMessagesDb(sql) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Query failed: ${getErrorMessage(error)}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("messages-mcp-server started");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
