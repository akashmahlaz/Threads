# Changelog

All notable changes to Threads are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-11-18

### Fixed

- **Screenshots did not appear on the Marketplace listing.** The README linked
  them with relative paths, which the Marketplace cannot resolve. They now use
  absolute `raw.githubusercontent.com` URLs.
- **The extension icon was 1254x1254 and 2.1 MB.** Resampled to the 128x128 the
  Marketplace asks for, now 20 KB.

### Changed

- Pushing to `main` publishes automatically when `vscode-extension/**` changes.
  The version must be bumped in `package.json` first; the workflow refuses to
  republish a version that is already live.

## [0.5.0] - 2026-11-18

### Added

- **Notification sound.** A short chime plays when a message arrives, generated
  at runtime and played through the OS (`afplay`, `Media.SoundPlayer`,
  `paplay`/`aplay`/`ffplay`). Muted chats stay silent, and the chat you are
  reading does not chime. New setting: `threads.notifications.sound`.
- **Notifications.** A VS Code notification for messages in chats you are not
  looking at, with **Open** and **Mute** actions. New settings:
  `threads.notifications.enabled` and `threads.notifications.showPreview`.
- **Media.** Photos, video, voice notes, documents and stickers are downloaded
  once and cached on disk, so they are still there after a restart. New tool:
  `threads_whatsapp_get_media`.
- **Profile pictures.** Chat and contact photos are fetched and cached, shown in
  the chat list and the conversation header.
- **Presence.** Online and last-seen state from `presence.update`, shown in the
  header and the chat list.
- **Typing in the chat list.** A chat shows "typing…" in the list, not only in
  the open conversation.
- **Reactions.** Emoji reactions render as chips under the message.
- **Replies.** Hover a message to reply; the composer shows what you are
  replying to, and the reply is sent with a real WhatsApp quote.
- **Call logs.** Missed and completed calls appear as a system line in the chat.
- **Polls.** Poll questions and options render as a list.
- **Pinned chats.** Chats can be pinned and sort to the top.
- **Mute from the sidebar.** A mute button in the conversation header, plus the
  `threads_whatsapp_mute` tool.
- **Message forwarding.** Forwarded messages are labelled.
- **Tests.** 15 tests covering the local mirror, LID resolution, search,
  reactions, unread counts and persistence. Run with `npm test`.
- **Settings.** `threads.notifications.sound`,
  `threads.notifications.enabled`, `threads.notifications.showPreview`.
- **Commands.** `Threads: Play Notification Sound` and `Threads: Open Chat`.

### Fixed

- **Contacts showing as a raw number** (for example `+254034497798362`). Those
  are WhatsApp LIDs, not phone numbers. Threads now learns LID → phone mappings
  from Baileys' on-disk `lid-mapping` files as well as the live socket, so
  contacts resolve even when they have not messaged this computer this session.
  A chat name that is really just a raw identifier is no longer kept.
- **Search performance.** Message text is indexed in lower case once, so a
  keystroke no longer re-scans and re-lowercases the whole inbox.
- **Message history size.** The local mirror keeps 400 messages per chat
  (was 60) and 2,000 chats (was 500).
- **Reconnects.** The socket retries 8 times (was 6) before giving up, with a
  clear error message.
- **Protocol version.** The WhatsApp version is read from WhatsApp's own
  service worker first, falling back to Baileys' bundled constant.

### Changed

- Status broadcasts, newsletters and newsletter traffic are dropped at the
  socket (`shouldIgnoreJid`) instead of being filtered out of every event.
- `threads.notifications.sound` replaces the previous hard-coded behaviour.

## [0.4.1] - 2026-11-18

### Added

- LID → phone-number resolution for contacts addressed by `@lid`.
- Group participant names, so people who never messaged you still show a name.
- Read receipts, delivery ticks and unread badges.

### Fixed

- Chats, contacts and groups arriving from `messaging-history.set` are kept, so
  a re-linked computer imports history instead of showing an empty inbox.

## [0.4.0] - 2026-11-18

### Added

- Initial public build: WhatsApp in the VS Code sidebar with Copilot tools.
- Chat list, conversation view, search, send, retry, archive and mute state.
- Copilot tools: send, list chats, read chat, search, groups, status.

[0.5.1]: https://github.com/akashmahlaz/Threads/releases/tag/v0.5.1
[0.5.0]: https://github.com/akashmahlaz/Threads/releases/tag/v0.5.0
[0.4.1]: https://github.com/akashmahlaz/Threads/releases/tag/v0.4.1
[0.4.0]: https://github.com/akashmahlaz/Threads/releases/tag/v0.4.0