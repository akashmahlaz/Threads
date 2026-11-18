import * as fs from 'fs';
import * as QRCode from 'qrcode';
import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    type Chat as WAChat,
    type ConnectionState,
    type Contact as WAContact,
    type GroupMetadata,
    type WAMessage,
    type WAMessageUpdate,
    type WASocket,
} from 'baileys';
import { extractMessage, isSupportedChat } from './extract';
import type { WhatsAppStore } from './store';
import type { ChatRecord, GroupRecord, MessageRecord } from './types';

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

const MAX_RECONNECTS = 6;

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
    private openChatId?: string;
    /** chatId -> epoch ms at which a "typing" signal stops counting. */
    private readonly typing = new Map<string, number>();
    /** Recent raw messages, served to Baileys for retries and edits. */
    private readonly rawCache = new Map<string, WAMessage>();

    private readonly _onDidChange = new Set<(status: WhatsAppStatus) => void>();
    private readonly _onInboxChange = new Set<() => void>();

    constructor(
        private readonly authDir: string,
        readonly store: WhatsAppStore,
        private readonly log: (message: string) => void = () => undefined,
    ) {}

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

    listChats(options: { includeArchived?: boolean; groupsOnly?: boolean } = {}): ChatRecord[] {
        return this.store.listChats(options);
    }

    readChat(chatId: string, limit = 50): MessageRecord[] {
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
        void this.stop();
        this._onDidChange.clear();
        this._onInboxChange.clear();
    }

    /**
     * Send a message and store it locally. `to` is a JID or a bare number.
     *
     * The message appears immediately with a pending tick, then becomes sent or
     * failed, so the sidebar never feels like it swallowed the message.
     */
    async send(to: string, text: string): Promise<void> {
        const body = text.trim();
        if (!body) throw new Error('Message text is empty');
        await this.waitUntilConnected();
        const sock = this.ensureSocket();

        const jid = await this.resolveJid(sock, to);
        const chatId = this.store.canonicalJid(jid);
        const pendingId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
        });
        this.fireInbox();

        let sent: WAMessage | undefined;
        try {
            sent = await sock.sendMessage(jid, { text: body });
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

    /** Resend a message that failed to go out. */
    async retry(chatId: string, messageId: string): Promise<void> {
        const message = this.store
            .listMessages(chatId, 200)
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
        const { version } = await fetchLatestBaileysVersion();

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
        sock.ev.on('message-receipt.update', (updates) => this.onReceipts(updates));
        sock.ev.on('presence.update', (payload) => this.onPresence(payload));
        sock.ev.on('messaging-history.set', (payload) => this.onHistory(payload));
        sock.ev.on('messaging-history.status', (payload) => {
            this.log(`History sync ${payload.syncType}: ${payload.status}`);
            if (payload.status === 'complete') {
                this.setState({ syncing: false });
                this.scheduleLidResolution();
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

        this.startKeepAlive();
        this.log(`Socket created (auth ${this.authDir})`);
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
            const account = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id).split('@')[0] : null;
            this.setState({
                state: 'connected',
                qrDataUrl: null,
                account,
                error: null,
                syncing: true,
            });
            this.log(`Connected as ${account ?? 'unknown'}`);
            void this.loadGroups();
            this.scheduleLidResolution();
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
            }
        }

        if (named.length) {
            this.store.setContacts(named);
            changed = true;
        }
        if (changed) this.fireInbox();
    }

    /** "typing…" signals from the other side of a conversation. */
    private onPresence(payload: {
        id: string;
        presences: Record<string, { lastKnownPresence?: string | null }>;
    }): void {
        const chatId = this.store.canonicalJid(payload.id);
        const composing = Object.values(payload.presences ?? {}).some(
            (presence) => presence.lastKnownPresence === 'composing',
        );
        if (composing) {
            this.typing.set(chatId, Date.now() + 12_000);
            this.fireInbox();
            return;
        }
        if (this.typing.delete(chatId)) this.fireInbox();
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
            .map((raw) => extractMessage(this.canonicalMessage(raw), this.extractContext()))
            .filter((record): record is MessageRecord => record !== null);
        const added = this.store.applyHistory(records);

        const progress = typeof payload.progress === 'number' ? Math.round(payload.progress) : null;
        this.log(
            `History chunk: ${payload.chats?.length ?? 0} chats, ${payload.messages?.length ?? 0} messages ` +
                `(${added} stored${progress !== null ? `, ${progress}%` : ''})`,
        );
        this.setState({ syncing: payload.isLatest !== true, chatCount: this.store.listChats().length });
        this.scheduleLidResolution();
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

    /**
     * WhatsApp addresses some contacts by LID. Resolve those to phone-number
     * JIDs so a chat is labelled with a number (or saved contact) instead of an
     * opaque identifier.
     */
    private scheduleLidResolution(): void {
        if (this.lidTimer) clearTimeout(this.lidTimer);
        this.lidTimer = setTimeout(() => {
            this.lidTimer = undefined;
            void this.resolveLids();
        }, 2_000);
    }

    private async resolveLids(): Promise<void> {
        const sock = this.sock;
        const mapping = sock?.signalRepository?.lidMapping;
        if (!sock || !mapping) return;

        const lids = this.store
            .listChats({ includeArchived: true })
            .map((chat) => chat.id)
            .filter((id) => id.endsWith('@lid'))
            .slice(0, 500);
        if (!lids.length) return;

        try {
            const pairs = await mapping.getPNsForLIDs(lids);
            if (!pairs?.length) return;
            this.store.setAliases(pairs);
            this.log(`Resolved ${pairs.length} of ${lids.length} LID chats to phone numbers`);
            this.fireInbox();
        } catch (err) {
            this.log(`LID lookup failed: ${err}`);
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

    // ── helpers ─────────────────────────────────────────────────────────────

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
        while (this.rawCache.size > 1_000) {
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
