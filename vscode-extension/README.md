# Threads

WhatsApp in your VS Code sidebar, with native Copilot tool calls.

## What it does

- **Your real inbox** — chats, contacts and groups (subject, member count, sender names) from WhatsApp
- **Readable messages** — text, captions, photos, video, voice notes, documents, stickers, locations, polls, quoted replies and group activity, instead of `[unsupported message]`
- **Two-way** — send from the sidebar or from Copilot; read receipts and unread badges
- **Copilot integration** — native tools so Copilot can list chats, read a group thread, search and reply
- **Local mirror** — WhatsApp only sends history when a computer is linked, so Threads keeps a local index (500 chats, 60 messages each) and appends new traffic

## Quick start

1. Install the extension
2. Click the Threads icon in the activity bar (or run `Threads: Start WhatsApp`)
3. Scan the QR code: WhatsApp → Settings → Linked devices → Link a device
4. Ask Copilot to "list my WhatsApp chats", "what did the design group say today?", or "send a WhatsApp to …"

### If the inbox is empty after pairing

WhatsApp sends chat history **only at link time**. If this computer was linked by an
older build, hit **Import history** in the sidebar banner (or run
`Threads: Unlink WhatsApp & Re-import`). The computer is unlinked and linked again,
which is what makes WhatsApp resend chats, contacts and groups.

## Copilot tools

- `threads_whatsapp_send` — send a message to a chat id or a phone number
- `threads_whatsapp_list_chats` — conversations with id, preview, unread count, archive/mute state
- `threads_whatsapp_read_chat` — messages of one conversation, oldest first, with senders and quotes
- `threads_whatsapp_search` — search stored messages for text
- `threads_whatsapp_groups` — every group with subject, id and member count

## Architecture

- **Baileys (`baileys`)** — the WhatsApp Web protocol, socket, pairing, reconnects and group metadata, all in the extension host. No separate process, no localhost port, no native binary.
- **`src/whatsapp/service.ts`** — socket lifecycle, history sync (`messaging-history.set`), chats/contacts/groups events, sending, read receipts
- **`src/whatsapp/extract.ts`** — turns WhatsApp protobuf messages into readable records and drops protocol noise
- **`src/whatsapp/store.ts`** — the local mirror (JSON), LID → phone-number resolution, name resolution
- **`src/sidebar.ts` / `media/main.js` / `media/style.css`** — the webview. The host renders the pairing QR to a PNG data URL; the webview has no network access.
- **`src/tools.ts`** — `vscode.lm.registerTool` handlers

Credentials live in `<globalStorage>/whatsapp-auth`; the inbox in `<globalStorage>/inbox.json`.
Logs: `~/Library/Logs/threads/threads.log` (`Threads: Open Logs`).

> Baileys is an unofficial WhatsApp Web client. WhatsApp may change its protocol,
> and using unofficial clients can put a number at risk. Use it knowingly.

## Development

```bash
npm install
npm run compile        # esbuild bundle -> dist/extension.js
npx tsc --noEmit       # typecheck
```

Package and install:

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension threads-<version>.vsix --force
```

Then `Developer: Reload Window`.
