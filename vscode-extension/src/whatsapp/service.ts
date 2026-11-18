import * as fs from 'fs';
import * as QRCode from 'qrcode';
import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    fetchLatestWaWebVersion,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    type Chat as WAChat,
    type ConnectionState,
    type Contact as WAContact,
    type GroupMetadata,
    type WACallEvent,
    type WAMessage,
    type WAMessageUpdate,
    type WASocket,
} from 'baileys';
import { extractMessage, isSupportedChat } from './extract';
import { MediaCache } from './media';
import { SoundPlayer, type SoundName } from './sound';
import type { WhatsAppStore } from './store';
import type { ChatRecord, GroupRecord, MessageRecord, ReactionRecord } from './types';

export type WhatsAppState = 'starting' | 'qr' | 'connected' | 'disconnected' | 'error';

export interface WhatsAppStatus {
    state: WhatsAppState;
    /** PNG data URL of the current pairing QR, when `state` is `qr`. */
    qrDataUrl: string | null;
    /** Phone number of the linked account, once connected. */
    account: string | null;
    error: string | null;
    /** True while WhatsApp is pushing chat/message history. */
    syncing: boolean;
    chatCount: number;
}

/** What a new message should do, decided by the caller (settings + mute state). */
export interface AlertOptions {
    sound: boolean;
    notification: boolean;
}

const MAX_RECONNECTS = 8;
/** How many LID chats to resolve per pass. */
const LID_BATCH = 200;

/**
 * WhatsApp over Baileys, driven from the extension host.
 *
 * Chat SDK's Baileys adapter is a bot-reply shim: it forwards only live
 * `messages.upsert` events and drops `messaging-history.set`, `chats.*`,
 * `contacts.*` and `groups.*`, which is exactly the data an inbox needs. This
 * service talks to the same Baileys socket the adapter would have created, and
 * keeps every event that matters.
 */
export class WhatsAppService {
    private sock?: WASocket;
    private status: WhatsAppStatus = {
        state: 'starting',
        qrDataUrl: null,
        account: null,
        error: null,
        syncing: false,
        chatCount: 0,
    };
    private starting = false;
    private disposed = false;
    private intentionalClose = false;
    private reconnectAttempts = 0;
    private reconnectTimer?: NodeJS.Timeout;
    private lidTimer?: NodeJS.Timeout;
    private keepAliveTimer?: NodeJS.Timeout;
    private typingSweep?: NodeJS.Timeout;
    private mediaTimer?: NodeJS.Timeout;
    private openChatId?: string;
    /** chatId -> epoch ms at which a "typing" signal stops counting. */
    private readonly typing = new Map<string, number>();
    /** Recent raw messages, served to Baileys for retries and edits. */
    private readonly rawCache = new Map<string, WAMessage>();
    /** Messages whose media still needs downloading. */
    private readonly mediaQueue: Array<{ raw: WAMessage; record: MessageRecord }> = [];
    private mediaDraining = false;

    private readonly _onDidChange = new Set<(status: WhatsAppStatus) => void>();
    private readonly _onInboxChange = new Set<() => void>();
    /** Fired when a message arrives that the user did not send. */
    private readonly _onIncoming = new Set<(message: MessageRecord, chat: ChatRecord) => void>();

    readonly media: MediaCache;
    private readonly sound: SoundPlayer;

    constructor(
        private readonly authDir: string,
        readonly store: WhatsAppStore,
        private readonly log: (message: string) => void = () => undefined,
        mediaDir?: string,
        soundDir?: string,
    ) {
        this.media = new MediaCache(mediaDir ?? `${authDir}-media`, log);
        this.sound = new SoundPlayer(soundDir ?? `${authDir}-sounds`, log);
    }

    // ── public surface ──────────────────────────────────────────────────────

    getStatus(): WhatsAppStatus {
        return { ...this.status, chatCount: this.store.listChats().length };
    }

    isConnected(): boolean {
        return this.status.state === 'connected';
    }

    onDidChange(listener: (status: WhatsAppStatus) => void): { dispose(): void } {
        this._onDidChange.add(listener);
        return { dispose: () => this._onDidChange.delete(listener) };
    }

    onInboxChange(listener: () => void): { dispose(): void } {
        this._onInboxChange.add(listener);
        return { dispose: () => this._onInboxChange.delete(listener) };
    }

    /** Fired for every incoming (not self) message, for sounds and notifications. */
    onIncoming(listener: (message: MessageRecord, chat: ChatRecord) => void): { dispose(): void } {
        this._onIncoming.add(listener);
        return { dispose: () => this._onIncoming.delete(listener) };
    }

    listChats(options: { includeArchived?: boolean; groupsOnly?: boolean } = {}): ChatRecord[] {
        return this.store.listChats(options);
    }

    readChat(chatId: string, limit = 80): MessageRecord[] {
        return this.store.listMessages(chatId, limit);
    }

    listGroups(): GroupRecord[] {
        return this.store.listGroups();
    }

    groupMembers(chatId: string): number {
        return this.store.listGroups().find((group) => group.id === chatId)?.members ?? 0;
    }

    search(query: string, limit = 50): Array<{ chat: ChatRecord; message: MessageRecord }> {
        return this.store.search(query, limit);
    }

    /** Play a chime through the OS, honouring the mute state of that chat. */
    playSound(kind: SoundName = 'message', chatId?: string): void {
        if (chatId) {
            const chat = this.store.getChat(chatId);
            if (chat?.muted) return;
        }
        this.sound.play(kind);
    }

    /** Download a message's media on demand (a click in the sidebar). */
    async loadMedia(chatId: string, messageId: string): Promise<string | undefined> {
        const record = this.store.listMessages(chatId, 400).find((m) => m.id === messageId);
        if (!record) return undefined;
        const raw = this.rawCache.get(messageId);
        if (!raw) return undefined;
        const file = await this.media.ensure(raw, record);
        if (file) {
            this.store.updateMessage(chatId, messageId, { media: { ...record.media, file, failed: false } });
            this.fireInbox();
        } else {
            this.store.updateMessage(chatId, messageId, { media: { ...record.media, failed: true } });
            this.fireInbox();
        }
        return file;
    }

    async start(): Promise<void> {
        if (this.disposed || this.starting) return;
        if (this.sock && this.isConnected()) return;

        this.starting = true;
        this.clearReconnect();
        try {
            if (this.sock) await this.stop();
            await this.boot();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log(`WhatsApp start failed: ${message}`);
            this.setState({ state: 'error', qrDataUrl: null, error: message, syncing: false });
            this.scheduleReconnect();
        } finally {
            this.starting = false;
        }
    }

    /** Unlink this computer and pair again, importing history from scratch. */
    async relink(): Promise<void> {
        this.log('Relinking WhatsApp (history will be re-imported)');
        this.intentionalClose = true;
        this.clearReconnect();
        try {
            // Unlink on the phone too, so the old device entry disappears.
            await this.sock?.logout();
        } catch (err) {
            this.log(`Logout request failed: ${err}`);
        }
        this.sock = undefined;
        await this.wipeCredentials();
        await this.start();
    }

    async stop(): Promise<void> {
        this.intentionalClose = true;
        this.clearReconnect();
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = undefined;
        this.typing.clear();
        const sock = this.sock;
        this.sock = undefined;
        try {
            sock?.end(undefined);
        } catch (err) {
            this.log(`Socket close failed: ${err}`);
        }
        this.setState({
            state: 'disconnected',
            qrDataUrl: null,
            account: null,
            error: null,
            syncing: false,
        });
    }

    dispose(): void {
        this.disposed = true;
        if (this.lidTimer) clearTimeout(this.lidTimer);
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        if (this.typingSweep) clearInterval(this.typingSweep);
        if (this.mediaTimer) clearTimeout(this.mediaTimer);
        void this.stop();
        this._onDidChange.clear();
        this._onInboxChange.clear();
        this._onIncoming.clear();
    }

    /**
     * Send a message and store it locally. `to` is a JID or a bare number.
     *
     * The message appears immediately with a pending tick, then becomes sent or
     * failed, so the sidebar never feels like it swallowed the message.
     */
    async send(to: string, text: string, replyToId?: string): Promise<void> {
        const body = text.trim();
        if (!body) throw new Error('Message text is empty');
        await this.waitUntilConnected();
        const sock = this.ensureSocket();

        const jid = await this.resolveJid(sock, to);
        const chatId = this.store.canonicalJid(jid);
        const pendingId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Quoting a message means attaching its text and sender to the
        // outgoing message, which is what WhatsApp shows above the bubble.
        const quoted = replyToId ? this.quoteFor(chatId, replyToId) : undefined;

        this.store.upsertChat({ id: chatId });
        this.store.applyMessage({
            id: pendingId,
            chatId,
            text: body,
            kind: 'text',
            senderId: sock.user?.id ?? '',
            senderName: 'You',
            isMe: true,
            timestamp: Date.now(),
            status: 'pending',
            quoted,
        });
        this.fireInbox();

        let sent: WAMessage | undefined;
        try {
            sent = await sock.sendMessage(jid, {
                text: body,
                // Quoting is a contextInfo block naming the original sender
                // and carrying the original message.
                ...(quoted
                    ? {
                          contextInfo: {
                              stanzaId: replyToId,
                              participant: quoted.senderId,
                              quotedMessage: this.rawFor(chatId, replyToId!)?.message ?? {
                                  conversation: quoted.text,
                              },
                          },
                      }
                    : {}),
            });
        } catch (err) {
            this.store.updateMessage(chatId, pendingId, { status: 'failed' });
            this.fireInbox();
            throw err;
        }

        this.store.removeMessage(chatId, pendingId);
        if (sent) this.cacheRaw(sent);
        const record = sent ? extractMessage(this.canonicalMessage(sent), this.extractContext()) : null;
        if (record) {
            record.status = 'sent';
            this.store.applyMessage(record);
        }
        this.fireInbox();
    }

    /** The stored text and sender for a message being replied to. */
    private quoteFor(chatId: string, messageId: string): MessageRecord['quoted'] | undefined {
        const message = this.store.listMessages(chatId, 400).find((m) => m.id === messageId);
        if (!message) return undefined;
        return {
            text: message.text,
            senderName: message.isMe ? 'You' : message.senderName,
            senderId: message.senderId,
        };
    }

    /** The raw Baileys message for a reply, when we still have it cached. */
    private rawFor(chatId: string, messageId: string): WAMessage | undefined {
        void chatId;
        return this.rawCache.get(messageId);
    }

    /** Resend a message that failed to go out. */
    async retry(chatId: string, messageId: string): Promise<void> {
        const message = this.store
            .listMessages(chatId, 400)
            .find((candidate) => candidate.id === messageId);
        if (!message) return;
        this.store.removeMessage(chatId, messageId);
        this.fireInbox();
        await this.send(chatId, message.text);
    }

    /** Open (or create) a conversation with a phone number. */
    async newChat(to: string): Promise<string> {
        const sock = this.ensureSocket();
        const jid = await this.resolveJid(sock, to);
        const chatId = this.store.canonicalJid(jid);
        this.store.upsertChat({ id: chatId, name: this.store.nameFor(chatId) });
        this.fireInbox();
        return chatId;
    }

    /** Toggle a chat's mute flag from the sidebar. */
    setMuted(chatId: string, muted: boolean): void {
        if (!this.store.setMuted(chatId, muted)) return;
        this.fireInbox();
    }

    /** Pin or unpin a chat. */
    setPinned(chatId: string, pinned: boolean): void {
        if (!this.store.setPinned(chatId, pinned)) return;
        this.fireInbox();
    }

    /**
     * Connect on demand (tool calls, sending) and wait for the link to open.
     * The socket is not opened at window startup, so two windows never fight
     * over one WhatsApp session.
     */
    async waitUntilConnected(timeoutMs = 25_000): Promise<void> {
        if (this.isConnected()) return;
        await this.start();

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.isConnected()) return;
            if (this.status.state === 'error') {
                throw new Error(this.status.error ?? 'WhatsApp could not connect.');
            }
            if (this.status.state === 'qr') {
                throw new Error(
                    'WhatsApp is not linked yet. Scan the QR code in the Threads sidebar ' +
                        '(activity bar → Threads), then try again.',
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error('WhatsApp did not connect in time. Open the Threads sidebar to check the link.');
    }

    /** True while the other side is typing in this chat. */
    isTyping(chatId: string): boolean {
        const until = this.typing.get(chatId);
        return Boolean(until && until > Date.now());
    }

    /** True when this chat has no stored messages, used by the empty state. */
    hasMessages(chatId: string): boolean {
        return this.store.listMessages(chatId, 1).length > 0;
    }

    /** The user left the conversation: stop auto-reading its messages. */
    closeChat(): void {
        this.openChatId = undefined;
    }

    /** The chat the user is currently looking at, if any. */
    currentChatId(): string | undefined {
        return this.openChatId;
    }

    /** The user opened a chat: clear the badge and send read receipts. */
    async openChat(chatId: string): Promise<void> {
        this.openChatId = chatId;
        const changed = this.store.clearUnread(chatId);
        const key = this.store.lastKey(chatId);
        if (key && this.sock) {
            try {
                await this.sock.readMessages([
                    {
                        remoteJid: chatId,
                        id: key.id,
                        fromMe: key.isMe,
                        participant: chatId.endsWith('@g.us') ? key.senderId : undefined,
                    },
                ]);
            } catch {
                // Read receipts are best-effort.
            }
        }
        if (changed) this.fireInbox();
    }

    // ── socket lifecycle ────────────────────────────────────────────────────

    private async boot(): Promise<void> {
        if (this.disposed) return;
        this.setState({ state: 'starting', qrDataUrl: null, error: null });

        fs.mkdirSync(this.authDir, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        const version = await this.resolveVersion();

        this.intentionalClose = false;
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
            },
            logger: silentLogger,
            browser: Browsers.macOS('Chrome'),
            markOnlineOnConnect: false,
            syncFullHistory: true,
            shouldSyncHistoryMessage: () => true,
            generateHighQualityLinkPreview: false,
            // Status broadcasts, newsletters and the "message yourself" chat
            // are not conversations; dropping them at the socket saves the
            // inbox from having to filter them out of every event.
            shouldIgnoreJid: (jid) => !isSupportedChat(jid),
            getMessage: async (key) => {
                const cached = key.id ? this.rawCache.get(key.id) : undefined;
                return cached?.message ?? undefined;
            },
        });
        this.sock = sock;

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => void this.onConnectionUpdate(update));
        sock.ev.on('messages.upsert', (payload) => this.onMessages(payload));
        sock.ev.on('messages.update', (updates) => this.onMessageUpdates(updates));
        sock.ev.on('messages.delete', (payload) => this.onMessagesDeleted(payload));
        sock.ev.on('messages.reaction', (updates) => this.onReactions(updates));
        sock.ev.on('message-receipt.update', (updates) => this.onReceipts(updates));
        sock.ev.on('presence.update', (payload) => this.onPresence(payload));
        sock.ev.on('messaging-history.set', (payload) => this.onHistory(payload));
        sock.ev.on('messaging-history.status', (payload) => {
            this.log(`History sync ${payload.syncType}: ${payload.status}`);
            if (payload.status === 'complete') {
                this.setState({ syncing: false });
                this.scheduleLidResolution(500);
                this.fireInbox();
            }
        });
        sock.ev.on('chats.upsert', (chats) => {
            this.mergeChats(chats);
            this.fireInbox();
        });
        sock.ev.on('chats.update', (updates) => {
            this.mergeChats(updates as WAChat[]);
            this.fireInbox();
        });
        sock.ev.on('contacts.upsert', (contacts) => {
            this.mergeContacts(contacts);
            this.fireInbox();
        });
        sock.ev.on('contacts.update', (contacts) => {
            this.mergeContacts(contacts as WAContact[]);
            this.fireInbox();
        });
        sock.ev.on('groups.upsert', (groups) => {
            this.mergeGroups(groups);
            this.fireInbox();
        });
        sock.ev.on('groups.update', (groups) => {
            this.mergeGroups(groups as GroupMetadata[]);
            this.fireInbox();
        });
        sock.ev.on('call', (calls) => this.onCalls(calls));

        this.startKeepAlive();
        this.log(`Socket created (auth ${this.authDir})`);
    }

    /**
     * Prefer WhatsApp's own service worker for the protocol version, and fall
     * back to Baileys' copy of the GitHub constant when that is unreachable.
     */
    private async resolveVersion(): Promise<[number, number, number]> {
        try {
            const { version, isLatest } = await fetchLatestWaWebVersion();
            if (isLatest) return version as [number, number, number];
            this.log(`WhatsApp version fetch was stale (${version.join('.')}); using it anyway`);
            return version as [number, number, number];
        } catch (err) {
            this.log(`WhatsApp version fetch failed: ${err instanceof Error ? err.message : err}`);
        }
        try {
            const { version } = await fetchLatestBaileysVersion();
            return version as [number, number, number];
        } catch (err) {
            this.log(`Baileys version fetch failed: ${err instanceof Error ? err.message : err}`);
        }
        return [2, 3000, 1043857760];
    }

    private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            await this.publishQr(qr);
            return;
        }
        if (connection === 'connecting') {
            if (this.status.state !== 'qr') this.setState({ state: 'starting' });
            return;
        }
        if (connection === 'open') {
            this.reconnectAttempts = 0;
            const account = this.sock?.user?.id
                ? jidNormalizedUser(this.sock.user.id).split('@')[0]
                : null;
            this.setState({
                state: 'connected',
                qrDataUrl: null,
                account,
                error: null,
                syncing: true,
            });
            this.log(`Connected as ${account ?? 'unknown'}`);
            void this.loadGroups();
            this.scheduleLidResolution(1_000);
            return;
        }

        if (connection !== 'close') return;

        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
            ?.output?.statusCode;
        if (this.intentionalClose) return;

        if (statusCode === DisconnectReason.connectionReplaced) {
            this.log('Another window took over this WhatsApp session; staying offline here');
            this.setState({
                state: 'error',
                qrDataUrl: null,
                account: null,
                error: 'WhatsApp is linked in another VS Code window. Use that window, or reload this one.',
                syncing: false,
            });
            return;
        }

        if (statusCode === DisconnectReason.loggedOut) {
            this.log('This computer was unlinked from WhatsApp; pairing again');
            this.setState({
                state: 'error',
                qrDataUrl: null,
                account: null,
                error: 'This computer was unlinked from WhatsApp. Scan the code to link it again.',
                syncing: false,
            });
            void this.wipeCredentials().then(() => this.start());
            return;
        }

        this.log(`Connection closed (code ${statusCode ?? 'unknown'}); reconnecting`);
        this.setState({ state: 'disconnected', account: null, qrDataUrl: null, syncing: false });
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.disposed) return;
        if (this.reconnectAttempts >= MAX_RECONNECTS) {
            this.setState({
                state: 'error',
                error: 'Could not reconnect to WhatsApp. Run "Threads: Start WhatsApp" to try again.',
            });
            return;
        }
        const delay = Math.min(2_000 * 2 ** this.reconnectAttempts, 30_000);
        this.reconnectAttempts += 1;
        this.clearReconnect();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.start();
        }, delay);
    }

    private clearReconnect(): void {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
    }

    private async wipeCredentials(): Promise<void> {
        try {
            fs.rmSync(this.authDir, { recursive: true, force: true });
        } catch (err) {
            this.log(`Could not remove credentials: ${err}`);
        }
    }

    // ── events ──────────────────────────────────────────────────────────────

    private onMessages(payload: { messages: WAMessage[]; type: string }): void {
        let changed = false;
        const named: Array<{ id: string; notify: string }> = [];
        const incoming: Array<{ record: MessageRecord; chat: ChatRecord }> = [];

        for (const raw of payload.messages) {
            this.cacheRaw(raw);
            const record = extractMessage(this.canonicalMessage(raw), this.extractContext());
            if (!record) continue;

            // Keep the push name so this person stays named in later messages.
            if (!record.isMe && raw.pushName && record.senderId) {
                named.push({ id: record.senderId, notify: raw.pushName });
            }

            if (this.typing.delete(record.chatId)) changed = true;
            if (this.store.applyMessage(record)) changed = true;

            if (!record.isMe && record.chatId === this.openChatId) {
                this.store.clearUnread(record.chatId);
                this.markRead(record);
            } else if (!record.isMe) {
                const chat = this.store.getChat(record.chatId);
                if (chat) incoming.push({ record, chat });
            }

            // Media links expire, so queue the download while the socket is up.
            if (record.kind !== 'text' && record.kind !== 'system' && record.kind !== 'other') {
                this.queueMedia(raw, record);
            }
        }

        if (named.length) {
            this.store.setContacts(named);
            changed = true;
        }
        if (changed) this.fireInbox();

        for (const item of incoming) {
            for (const listener of this._onIncoming) listener(item.record, item.chat);
        }
    }

    /** "typing…" and presence signals from the other side of a conversation. */
    private onPresence(payload: {
        id: string;
        presences: Record<string, { lastKnownPresence?: string | null; lastSeen?: number | null }>;
    }): void {
        const chatId = this.store.canonicalJid(payload.id);
        const entries = Object.values(payload.presences ?? {});
        const composing = entries.some((presence) => presence.lastKnownPresence === 'composing');
        const online = entries.some(
            (presence) =>
                presence.lastKnownPresence === 'available' || presence.lastKnownPresence === 'composing',
        );
        const lastSeen = entries
            .map((presence) => presence.lastSeen)
            .filter((value): value is number => typeof value === 'number' && value > 0)
            .sort((a, b) => b - a)[0];

        let changed = false;
        if (composing) {
            this.typing.set(chatId, Date.now() + 12_000);
            changed = true;
        } else if (this.typing.delete(chatId)) {
            changed = true;
        }
        if (this.store.setChatPresence(chatId, { online, lastSeen })) changed = true;
        if (changed) this.fireInbox();
    }

    /** Emoji reactions, which arrive on their own event rather than in a message. */
    private onReactions(
        updates: Array<{
            key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null };
            reaction: { text?: string | null };
        }>,
    ): void {
        let changed = false;
        for (const update of updates) {
            const chatId = update.key.remoteJid;
            const id = update.key.id;
            if (!chatId || !id) continue;

            const senderId = update.key.participant ?? (update.key.fromMe ? 'me' : chatId);
            const reaction: ReactionRecord = {
                text: update.reaction.text ?? '',
                senderId,
                senderName: this.store.nameFor(senderId),
            };
            if (this.store.setReaction(chatId, id, reaction)) changed = true;
        }
        if (changed) this.fireInbox();
    }

    /** Missed and completed call logs, shown as a system line in the chat. */
    private onCalls(calls: WACallEvent[]): void {
        let changed = false;
        for (const call of calls) {
            // Only record the terminal states; offer/ringing are noise.
            if (call.status !== 'terminate' && call.status !== 'reject' && call.status !== 'timeout') {
                continue;
            }
            const chatId = this.store.canonicalJid(call.chatId);
            if (!isSupportedChat(chatId)) continue;
            const label = call.isVideo ? 'Video call' : 'Voice call';
            const outcome =
                call.status === 'reject' ? 'declined' : call.status === 'timeout' ? 'missed' : 'ended';
            const record: MessageRecord = {
                id: `call-${call.id}`,
                chatId,
                text: `${label} · ${outcome}`,
                kind: 'call',
                senderId: call.from,
                senderName: this.store.nameFor(call.from),
                isMe: false,
                timestamp: call.date.getTime(),
            };
            if (this.store.applyMessage(record)) changed = true;
        }
        if (changed) this.fireInbox();
    }

    /**
     * A laptop that sleeps can leave a socket that looks open but is dead.
     * This notices and reconnects, so messages start arriving again without a
     * window reload.
     */
    private startKeepAlive(): void {
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        if (!this.typingSweep) {
            this.typingSweep = setInterval(() => {
                let changed = false;
                for (const [chatId, until] of [...this.typing]) {
                    if (until <= Date.now()) {
                        this.typing.delete(chatId);
                        changed = true;
                    }
                }
                if (changed) this.fireInbox();
            }, 5_000);
        }
        this.keepAliveTimer = setInterval(() => this.checkSocket(), 45_000);
    }

    private checkSocket(): void {
        if (this.disposed || this.intentionalClose || this.reconnectTimer) return;
        const sock = this.sock;
        if (!sock) return;
        const ws = (sock as unknown as { ws?: { isOpen?: boolean; isClosed?: boolean } }).ws;
        if (ws && (ws.isOpen === false || ws.isClosed === true)) {
            this.log('Socket stopped responding; reconnecting');
            this.sock = undefined;
            this.setState({ state: 'disconnected', account: null, qrDataUrl: null, syncing: false });
            this.scheduleReconnect();
        }
    }

    /** Edits, deletions and delivery-status changes for existing messages. */
    private onMessageUpdates(updates: WAMessageUpdate[]): void {
        let changed = false;
        for (const { key, update } of updates) {
            const chatId = key.remoteJid;
            if (!chatId || !key.id) continue;
            const id = this.store.canonicalJid(chatId);

            // 14 = protocol REVOKE ("delete for everyone").
            if (update.message?.protocolMessage?.type === 14) {
                changed =
                    this.store.updateMessage(id, key.id, {
                        deleted: true,
                        text: 'This message was deleted',
                        kind: 'system',
                    }) || changed;
                continue;
            }

            const edited = update.message?.editedMessage;
            if (edited?.message) {
                const record = extractMessage(
                    {
                        key,
                        message: edited.message,
                        messageTimestamp: update.messageTimestamp ?? Math.floor(Date.now() / 1000),
                    } as WAMessage,
                    this.extractContext(),
                );
                if (record) {
                    changed =
                        this.store.updateMessage(id, key.id, {
                            text: record.text,
                            kind: record.kind,
                            media: record.media,
                            quoted: record.quoted,
                            edited: true,
                        }) || changed;
                }
                continue;
            }

            if (typeof update.status === 'number') {
                const status = statusName(update.status);
                if (status) changed = this.store.updateMessage(id, key.id, { status }) || changed;
            }
        }
        if (changed) this.fireInbox();
    }

    private onMessagesDeleted(payload: {
        keys?: Array<{ id?: string | null; remoteJid?: string | null }>;
        jid?: string;
        all?: boolean;
    }): void {
        let changed = false;
        for (const key of payload.keys ?? []) {
            const chatId = key.remoteJid ?? payload.jid;
            if (!key.id || !chatId) continue;
            changed =
                this.store.updateMessage(this.store.canonicalJid(chatId), key.id, {
                    deleted: true,
                    text: 'This message was deleted',
                    kind: 'system',
                }) || changed;
        }
        if (changed) this.fireInbox();
    }

    private onReceipts(
        updates: Array<{
            key: { id?: string | null; remoteJid?: string | null };
            receipt: { readTimestamp?: unknown; receiptTimestamp?: unknown };
        }>,
    ): void {
        const read = new Map<string, string[]>();
        const delivered = new Map<string, string[]>();
        for (const update of updates) {
            const chatId = update.key.remoteJid;
            const id = update.key.id;
            if (!chatId || !id) continue;
            const target = update.receipt.readTimestamp ? read : delivered;
            const list = target.get(chatId) ?? [];
            list.push(id);
            target.set(chatId, list);
        }

        let changed = false;
        for (const [chatId, ids] of delivered) {
            if (!read.has(chatId)) changed = this.store.setReceipt(chatId, ids, 'delivered') || changed;
        }
        for (const [chatId, ids] of read) {
            changed = this.store.setReceipt(chatId, ids, 'read') || changed;
        }
        if (changed) this.fireInbox();
    }

    private onHistory(payload: {
        chats: WAChat[];
        contacts: WAContact[];
        messages: WAMessage[];
        progress?: number | null;
        isLatest?: boolean;
        lidPnMappings?: Array<{ lid?: string | null; pn?: string | null }>;
    }): void {
        this.store.setAliases(payload.lidPnMappings ?? []);
        this.mergeContacts(payload.contacts ?? []);
        this.mergeChats(payload.chats ?? []);

        const records = (payload.messages ?? [])
            .map((raw) => {
                const record = extractMessage(this.canonicalMessage(raw), this.extractContext());
                if (record) this.cacheRaw(raw);
                return record;
            })
            .filter((record): record is MessageRecord => record !== null);
        const added = this.store.applyHistory(records);

        const progress = typeof payload.progress === 'number' ? Math.round(payload.progress) : null;
        this.log(
            `History chunk: ${payload.chats?.length ?? 0} chats, ${payload.messages?.length ?? 0} messages ` +
                `(${added} stored${progress !== null ? `, ${progress}%` : ''})`,
        );
        this.setState({ syncing: payload.isLatest !== true, chatCount: this.store.listChats().length });
        this.scheduleLidResolution(1_500);
        this.fireInbox();
    }

    /** Point a message at the phone-number JID once WhatsApp tells us the LID. */
    private canonicalMessage(raw: WAMessage): WAMessage {
        const chatId = raw.key?.remoteJid ? this.store.canonicalJid(raw.key.remoteJid) : undefined;
        const participant = raw.key?.participant
            ? this.store.canonicalJid(raw.key.participant)
            : undefined;
        if (chatId === raw.key?.remoteJid && participant === raw.key?.participant) return raw;
        return {
            ...raw,
            key: { ...raw.key, remoteJid: chatId ?? raw.key.remoteJid, participant },
        };
    }

    private mergeChats(chats: Array<Partial<WAChat> & { id?: string | null }>): void {
        for (const chat of chats) {
            if (!chat.id || !isSupportedChat(chat.id)) continue;
            const id = this.store.canonicalJid(chat.id);
            if (!isSupportedChat(id)) continue;
            const timestamp = toMillis(chat.conversationTimestamp ?? chat.lastMsgTimestamp);
            this.store.upsertChat({
                id,
                name: chat.name ?? undefined,
                isGroup: id.endsWith('@g.us'),
                unread: chat.unreadCount ?? undefined,
                archived: chat.archived ?? undefined,
                muted: Boolean(chat.muteEndTime && toMillis(chat.muteEndTime) > Date.now()),
                lastTimestamp: timestamp || undefined,
                pinned: chat.pinned ? true : undefined,
            });
        }
    }

    private mergeContacts(contacts: WAContact[]): void {
        this.store.setContacts(
            contacts
                .filter((contact) => contact.id)
                .map((contact) => ({
                    id: contact.id,
                    name: contact.name ?? undefined,
                    notify: contact.notify ?? undefined,
                    phone: contact.phoneNumber ?? undefined,
                    username: contact.username ?? undefined,
                })),
        );
    }

    private mergeGroups(groups: Array<Partial<GroupMetadata> & { id?: string }>): void {
        // Group participant lists carry names for people who never messaged us.
        const participants = groups.flatMap((group) =>
            (group.participants ?? []).map((participant) => ({
                id: participant.id,
                name: participant.name ?? undefined,
                notify: participant.notify ?? undefined,
                phone: participant.phoneNumber ?? undefined,
                username: participant.username ?? undefined,
            })),
        );
        if (participants.length) this.store.setContacts(participants);

        const records = groups
            .filter((group): group is GroupMetadata => Boolean(group.id))
            .map((group) => ({
                id: group.id,
                subject: group.subject ?? '',
                members: group.participants?.length ?? group.size ?? 0,
                description: group.desc ?? undefined,
            }));
        this.store.setGroups(records);
        for (const group of records) {
            if (!this.store.getChat(group.id)) {
                this.store.upsertChat({
                    id: group.id,
                    name: group.subject,
                    isGroup: true,
                });
            }
        }
    }

    // ── LID resolution ──────────────────────────────────────────────────────

    /**
     * WhatsApp addresses some contacts by LID. Resolve those to phone-number
     * JIDs so a chat is labelled with a number (or saved contact) instead of an
     * opaque identifier.
     *
     * Two sources are used: the on-disk `lid-mapping` files Baileys keeps in the
     * auth folder (which cover every contact ever mapped, including ones that
     * have not messaged us this session), and the live socket's own mapping
     * store. The disk pass is what fixes a contact showing up as
     * `+254034497798362` instead of its name.
     */
    private scheduleLidResolution(delayMs = 2_000): void {
        if (this.lidTimer) clearTimeout(this.lidTimer);
        this.lidTimer = setTimeout(() => {
            this.lidTimer = undefined;
            void this.resolveLids();
        }, delayMs);
    }

    private async resolveLids(): Promise<void> {
        // The disk pass is cheap and covers contacts the socket never mentions.
        const fromDisk = this.store.learnAliasesFromDisk(this.authDir);
        if (fromDisk > 0) {
            this.log(`Learned ${fromDisk} LID → phone mappings from disk`);
            this.fireInbox();
        }

        const sock = this.sock;
        const mapping = sock?.signalRepository?.lidMapping;
        if (!sock || !mapping) return;

        const pending = this.store.unresolvedLidChats();
        if (!pending.length) return;

        // Work in batches: one huge USync query gets rejected by the server.
        let resolved = 0;
        for (let index = 0; index < pending.length; index += LID_BATCH) {
            const batch = pending.slice(index, index + LID_BATCH);
            try {
                const pairs = await mapping.getPNsForLIDs(batch);
                if (pairs?.length) {
                    this.store.setAliases(pairs);
                    resolved += pairs.length;
                }
            } catch (err) {
                this.log(`LID lookup failed for ${batch.length} chats: ${err}`);
            }
        }

        if (resolved > 0) {
            this.log(`Resolved ${resolved} of ${pending.length} LID chats to phone numbers`);
            this.fireInbox();
        }
    }

    /** Ask WhatsApp for every group this account belongs to. */
    private async loadGroups(): Promise<void> {
        try {
            const groups = await this.sock?.groupFetchAllParticipating();
            if (!groups) return;
            this.mergeGroups(Object.values(groups));
            this.log(`Loaded ${Object.keys(groups).length} groups`);
            this.fireInbox();
        } catch (err) {
            this.log(`Group list failed: ${err}`);
        }
    }

    // ── media ───────────────────────────────────────────────────────────────

    private queueMedia(raw: WAMessage, record: MessageRecord): void {
        if (record.media?.file || record.media?.failed) return;
        if (this.mediaQueue.some((item) => item.record.id === record.id)) return;
        this.mediaQueue.push({ raw, record });
        this.scheduleMediaDrain();
    }

    private scheduleMediaDrain(): void {
        if (this.mediaTimer) return;
        this.mediaTimer = setTimeout(() => {
            this.mediaTimer = undefined;
            void this.drainMedia();
        }, 750);
    }

    /**
     * Download queued media a few at a time.
     *
     * Sequential with a small pause: a fresh account with a long history can
     * queue hundreds of items, and downloading them all at once looks like
     * abuse to WhatsApp's CDN.
     */
    private async drainMedia(): Promise<void> {
        if (this.mediaDraining || this.disposed) return;
        this.mediaDraining = true;
        try {
            while (this.mediaQueue.length && !this.disposed) {
                const item = this.mediaQueue.shift();
                if (!item) break;
                const file = await this.media.ensure(item.raw, item.record);
                if (file) {
                    this.store.updateMessage(item.record.chatId, item.record.id, {
                        media: { ...item.record.media, file, failed: false },
                    });
                    this.fireInbox();
                } else {
                    this.store.updateMessage(item.record.chatId, item.record.id, {
                        media: { ...item.record.media, failed: true },
                    });
                }
            }
        } finally {
            this.mediaDraining = false;
            if (this.mediaQueue.length) this.scheduleMediaDrain();
        }
    }

    // ── profile pictures ────────────────────────────────────────────────────

    /**
     * Fetch and cache the profile photo for the chats that do not have one.
     *
     * WhatsApp only returns a URL for contacts that share their photo, so a
     * missing avatar is normal and not an error.
     */
    async loadAvatars(chatIds?: string[]): Promise<number> {
        const sock = this.sock;
        if (!sock || !this.isConnected()) return 0;

        const chats = (chatIds ? chatIds.map((id) => this.store.getChat(id)) : this.store.listChats())
            .filter((chat): chat is ChatRecord => Boolean(chat))
            .filter((chat) => !chat.avatar)
            .slice(0, 40);
        if (!chats.length) return 0;

        let loaded = 0;
        for (const chat of chats) {
            try {
                const url = await sock.profilePictureUrl(chat.id, 'preview');
                if (!url) continue;
                const file = await this.media.avatar(url, chat.id);
                if (!file) continue;
                if (this.store.setAvatar(chat.id, file)) loaded += 1;
            } catch {
                // No photo, or the contact hides it: both are fine.
            }
        }
        if (loaded > 0) {
            this.log(`Loaded ${loaded} profile pictures`);
            this.fireInbox();
        }
        return loaded;
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private async markRead(record: MessageRecord): Promise<void> {
        if (!this.sock) return;
        try {
            await this.sock.readMessages([
                {
                    remoteJid: record.chatId,
                    id: record.id,
                    fromMe: record.isMe,
                    participant: record.chatId.endsWith('@g.us') ? record.senderId : undefined,
                },
            ]);
        } catch {
            // Best-effort.
        }
    }

    private ensureSocket(): WASocket {
        const sock = this.sock;
        if (!sock || !this.isConnected()) {
            throw new Error('WhatsApp is not connected. Scan the QR code in the Threads sidebar.');
        }
        return sock;
    }

    private cacheRaw(raw: WAMessage): void {
        const id = raw.key?.id;
        if (!id) return;
        this.rawCache.set(id, raw);
        while (this.rawCache.size > 2_000) {
            const oldest = this.rawCache.keys().next().value;
            if (!oldest) break;
            this.rawCache.delete(oldest);
        }
    }

    private extractContext() {
        return {
            selfJid: this.sock?.user?.id ?? '',
            nameFor: (jid: string, pushName?: string) => this.store.nameFor(jid, pushName),
        };
    }

    /** Turn a chat id, group id or phone number into a sendable JID. */
    private async resolveJid(sock: WASocket, to: string): Promise<string> {
        const raw = to.trim();
        if (!raw) throw new Error('Missing recipient');
        if (raw.includes('@')) return raw;

        const digits = raw.replace(/[^\d]/g, '');
        if (!digits) throw new Error(`"${to}" is not a phone number or chat id`);

        try {
            const [match] = (await sock.onWhatsApp(digits)) ?? [];
            if (match?.jid) return match.jid;
            if (match && match.exists === false) {
                throw new Error(`${digits} is not on WhatsApp`);
            }
        } catch (err) {
            if (err instanceof Error && err.message.endsWith('is not on WhatsApp')) throw err;
            // Lookup needs the network; fall back to the canonical JID.
        }
        return `${digits}@s.whatsapp.net`;
    }

    private async publishQr(qr: string): Promise<void> {
        try {
            const qrDataUrl = await QRCode.toDataURL(qr, {
                width: 288,
                margin: 2,
                errorCorrectionLevel: 'M',
            });
            this.setState({ state: 'qr', qrDataUrl, account: null, error: null, syncing: false });
        } catch (err) {
            this.log(`QR render failed: ${err}`);
        }
    }

    private fireInbox(): void {
        for (const listener of this._onInboxChange) listener();
    }

    private setState(patch: Partial<WhatsAppStatus>): void {
        this.status = { ...this.status, ...patch };
        const snapshot = this.getStatus();
        for (const listener of this._onDidChange) listener(snapshot);
    }
}

interface Logger {
    level: string;
    child(obj: Record<string, unknown>): Logger;
    trace(obj: unknown, msg?: string): void;
    debug(obj: unknown, msg?: string): void;
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
}

/** Baileys is extremely chatty; keep only what is worth a log line. */
const silentLogger: Logger = {
    level: 'silent',
    child: () => silentLogger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

function statusName(status: number): 'pending' | 'sent' | 'delivered' | 'read' | undefined {
    switch (status) {
        case 1:
            return 'pending';
        case 2:
            return 'sent';
        case 3:
            return 'delivered';
        case 4:
            return 'read';
        default:
            return undefined;
    }
}

function toMillis(value: unknown): number {
    if (!value) return 0;
    if (typeof value === 'number') return value * 1000;
    const numberLike = value as { toNumber?: () => number };
    if (typeof numberLike.toNumber === 'function') return numberLike.toNumber() * 1000;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed * 1000 : 0;
}