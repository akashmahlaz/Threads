# Threads

WhatsApp in your VS Code sidebar, with native Copilot tool calls.

| Inbox | Conversation |
| --- | --- |
| ![Threads chat list](media/screenshots/list.png) | ![Threads conversation](media/screenshots/chat.png) |

## What it does

- **Your real inbox** — chats, contacts and groups (subject, member count, sender names) from WhatsApp
- **Readable messages** — text, captions, photos, video, voice notes, documents, stickers, locations, polls, call logs, quoted replies, reactions and group activity, instead of `[unsupported message]`
- **Two-way** — send from the sidebar or from Copilot; read receipts, delivery ticks, unread badges
- **Media that actually loads** — photos, video, voice notes and files are downloaded once and cached on disk, so they are still there after a restart
- **Real names, not raw IDs** — LID-addressed contacts are resolved to their phone number or saved name, including contacts that have never messaged you this session
- **Copilot integration** — native tools so Copilot can list chats, read a group thread, search, reply, mute and fetch attachments
- **Local mirror** — WhatsApp only sends history when a computer is linked, so Threads keeps a local index (2,000 chats, 400 messages each) and appends new traffic

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

### If a contact shows up as a number like `+254034497798362`

That is a WhatsApp **LID** (a linked-device identifier), not a phone number. Threads
resolves LIDs to phone numbers using two sources: the `lid-mapping` files Baileys
keeps in the auth folder, and the live socket's own mapping store. The disk pass runs
on connect and on every history sync, so contacts that were mapped on your phone are
resolved even if they have not messaged this computer yet.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `threads.notifications.sound` | on | Play a short chime when a message arrives. Muted chats stay silent. |
| `threads.notifications.enabled` | on | Show a VS Code notification for messages in chats you are not looking at. |
| `threads.notifications.showPreview` | on | Include the message text in the notification. Turn off on a shared screen. |

Run **Threads: Play Notification Sound** to check that audio works on your machine.

> VS Code has no API for playing a sound, and a webview's `Audio` object is blocked by
> autoplay policy and suspended when the sidebar is hidden — exactly when a chime
> matters. So the extension host plays the tone through the OS (`afplay` on macOS,
> `Media.SoundPlayer` on Windows, `paplay`/`aplay`/`ffplay` on Linux). The tone is
> generated as a small WAV at runtime, so no binary audio is shipped.

## Copilot tools

- `threads_whatsapp_send` — send a message to a chat id or a phone number
- `threads_whatsapp_list_chats` — conversations with id, preview, unread count, archive/mute/pin state, presence
- `threads_whatsapp_read_chat` — messages of one conversation, oldest first, with senders, quotes, reactions and poll options
- `threads_whatsapp_search` — search stored messages for text
- `threads_whatsapp_groups` — every group with subject, id and member count
- `threads_whatsapp_status` — connection state, account, stored counts, import progress
- `threads_whatsapp_mute` — mute or unmute a conversation
- `threads_whatsapp_get_media` — download a message's attachment and return the local path

## Architecture

- **Baileys (`baileys`)** — the WhatsApp Web protocol, socket, pairing, reconnects and group metadata, all in the extension host. No separate process, no localhost port, no native binary.
- **`src/whatsapp/service.ts`** — socket lifecycle, history sync (`messaging-history.set`), chats/contacts/groups events, sending, read receipts, presence, reactions, calls, LID resolution, media queue
- **`src/whatsapp/extract.ts`** — turns WhatsApp protobuf messages into readable records and drops protocol noise
- **`src/whatsapp/store.ts`** — the local mirror (JSON), LID → phone-number resolution, name resolution
- **`src/whatsapp/media.ts`** — downloads and caches attachments, keyed by message id
- **`src/whatsapp/sound.ts`** — generates and plays the notification chime through the OS
- **`src/sidebar.ts` / `media/main.js` / `media/style.css`** — the webview. The host renders the pairing QR to a PNG data URL and hands media over as `webview://` URLs; the webview has no network access.
- **`src/tools.ts`** — `vscode.lm.registerTool` handlers

Credentials live in `<globalStorage>/whatsapp-auth`; the inbox in `<globalStorage>/inbox.json`;
cached media in `<globalStorage>/media`.
Logs: `~/Library/Logs/threads/threads.log` on macOS, `%APPDATA%/threads/logs/` on Windows,
`~/.local/state/threads/logs/` on Linux (`Threads: Open Logs`).

> Baileys is an unofficial WhatsApp Web client. WhatsApp may change its protocol,
> and using unofficial clients can put a number at risk. Use it knowingly.

## Development

```bash
npm install
npm run compile        # esbuild bundle -> dist/extension.js
npm run typecheck      # tsc --noEmit
```

Package and install:

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension threads-<version>.vsix --force
```

Then `Developer: Reload Window`.