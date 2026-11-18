import * as fs from 'fs';
import * as path from 'path';
import type {
    ChatRecord,
    ContactRecord,
    GroupRecord,
    MessageKeyRef,
    MessageRecord,
    ReactionRecord,
} from './types';

/** How many conversations to keep. WhatsApp accounts can have thousands. */
const MAX_CHATS = 2_000;
/** How many messages to keep per conversation. */
const MAX_MESSAGES_PER_CHAT = 400;
/** How many contacts to keep. */
const MAX_CONTACTS = 8_000;

interface Snapshot {
    version: 4;
    chats: ChatRecord[];
    messages: Record<string, MessageRecord[]>;
    contacts: ContactRecord[];
    groups: GroupRecord[];
    keys: Record<string, MessageKeyRef>;
    aliases: Record<string, string>;
}

/**
 * Local mirror of the WhatsApp account.
 *
 * WhatsApp's linked-device protocol only pushes history to a *new* device, so
 * this store is what makes the inbox and the Copilot tools useful after a
 * restart: every chat, contact, group and recent message that has ever been
 * observed is kept here.
 */
export class WhatsAppStore {
    private chats = new Map<string, ChatRecord>();
    private messages = new Map<string, MessageRecord[]>();
    private contacts = new Map<string, ContactRecord>();
    private groups = new Map<string, GroupRecord>();
    private keys = new Map<string, MessageKeyRef>();
    /** LID (`@lid`) → phone-number JID, learned from contacts and history sync. */
    private aliases = new Map<string, string>();
    /**
     * Lowercased message text, rebuilt lazily.
     *
     * Searching a large inbox by re-lowercasing every message on every keystroke
     * is slow enough to feel; caching the folded text makes a keystroke a plain
     * `includes` over strings that are already lower case.
     */
    private searchIndex?: Map<string, string>;
    private saveTimer?: NodeJS.Timeout;
    private dirty = false;

    constructor(private readonly file: string) {}

    load(): void {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Snapshot;
            // v1 was written by the Chat SDK adapter build; its chat list is
            // noise, so start clean rather than migrate it.
            const version: number = data.version;
            if (version !== 2 && version !== 3 && version !== 4) return;
            for (const chat of data.chats ?? []) this.chats.set(chat.id, chat);
            for (const [id, list] of Object.entries(data.messages ?? {})) this.messages.set(id, list);
            for (const contact of data.contacts ?? []) this.contacts.set(contact.id, contact);
            for (const group of data.groups ?? []) this.groups.set(group.id, group);
            for (const [id, key] of Object.entries(data.keys ?? {})) this.keys.set(id, key);
            for (const [lid, pn] of Object.entries(data.aliases ?? {})) this.aliases.set(lid, pn);
        } catch {
            // First run, or a corrupt file we can rebuild from WhatsApp.
        }
    }

    // ── reads ───────────────────────────────────────────────────────────────

    listChats(options: { includeArchived?: boolean; groupsOnly?: boolean } = {}): ChatRecord[] {
        return [...this.chats.values()]
            .filter((chat) => options.includeArchived || !chat.archived)
            .filter((chat) => !options.groupsOnly || chat.isGroup)
            .sort((a, b) => {
                // Pinned chats float to the top, then newest activity.
                const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
                if (pin !== 0) return pin;
                return (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0);
            });
    }

    getChat(id: string): ChatRecord | undefined {
        return this.chats.get(id);
    }

    listGroups(): GroupRecord[] {
        return [...this.groups.values()].sort((a, b) => a.subject.localeCompare(b.subject));
    }

    listMessages(chatId: string, limit = MAX_MESSAGES_PER_CHAT): MessageRecord[] {
        return (this.messages.get(chatId) ?? []).slice(-limit);
    }

    /** Every stored message, for search. */
    allMessages(): MessageRecord[] {
        const out: MessageRecord[] = [];
        for (const list of this.messages.values()) out.push(...list);
        return out;
    }

    search(query: string, limit = 50): Array<{ chat: ChatRecord; message: MessageRecord }> {
        const needle = query.toLowerCase();
        if (!needle) return [];
        const index = this.searchText();
        const hits: Array<{ chat: ChatRecord; message: MessageRecord }> = [];
        for (const [chatId, list] of this.messages) {
            const chat = this.chats.get(chatId);
            if (!chat) continue;
            for (const message of list) {
                const haystack = index.get(message.id);
                if (haystack === undefined) continue;
                if (haystack.includes(needle)) {
                    hits.push({ chat, message });
                    if (hits.length >= limit) return hits;
                }
            }
        }
        return hits;
    }

    /** Lowercased text per message id, rebuilt when the message set changes. */
    private searchText(): Map<string, string> {
        if (this.searchIndex) return this.searchIndex;
        const index = new Map<string, string>();
        for (const list of this.messages.values()) {
            for (const message of list) {
                index.set(message.id, message.text.toLowerCase());
            }
        }
        this.searchIndex = index;
        return index;
    }

    lastKey(chatId: string): MessageKeyRef | undefined {
        return this.keys.get(chatId);
    }

    /** Display name for a JID: group subject, saved contact, push name, phone. */
    nameFor(jid: string, pushName?: string): string {
        const canonical = this.canonicalJid(jid);
        const group = this.groups.get(canonical);
        if (group?.subject) return group.subject;

        const contact =
            this.contacts.get(canonical) ??
            this.contacts.get(stripDevice(canonical)) ??
            this.contacts.get(stripDevice(jid));
        const saved = contact?.name || contact?.notify;
        // A chat name that is really just a raw LID or phone number is a
        // placeholder, not a name — fall through to something better.
        const chat = this.chats.get(canonical) ?? this.chats.get(jid);
        const chatName = chat?.name && !isLidName(chat.name) ? chat.name : undefined;
        return (
            saved ||
            chatName ||
            (contact?.username ? `@${contact.username.replace(/^@/, '')}` : '') ||
            (contact?.phone ? formatPhone(contact.phone) : '') ||
            pushName ||
            (canonical.endsWith('@g.us') ? 'Group' : formatPhone(canonical))
        );
    }

    /**
     * A short label for a chat that has no name.
     *
     * A LID is not a phone number, so rendering one as `+254034497798362` is a
     * lie about what the identifier is. Show a neutral label instead and let the
     * real name arrive once the alias resolves.
     */
    labelFor(jid: string): string {
        const canonical = this.canonicalJid(jid);
        if (canonical.endsWith('@g.us')) return 'Group';
        if (canonical.endsWith('@lid')) return 'WhatsApp contact';
        return formatPhone(canonical);
    }

    /**
     * WhatsApp addresses some contacts by LID (`…@lid`). When the phone-number
     * JID is known, use it so one person is one chat and the title is a number
     * rather than an opaque identifier.
     */
    canonicalJid(jid: string): string {
        let current = stripDevice(jid);
        for (let hop = 0; hop < 4; hop += 1) {
            const next = this.aliases.get(current);
            if (!next || next === current) break;
            current = stripDevice(next);
        }
        return current;
    }

    /** Every LID we know the phone number for. */
    lidAliases(): Array<[string, string]> {
        return [...this.aliases.entries()];
    }

    /** Chats still addressed by LID, i.e. the ones we still have to resolve. */
    unresolvedLidChats(): string[] {
        return [...this.chats.keys()]
            .filter((id) => id.endsWith('@lid'))
            .concat(
                [...this.contacts.keys()]
                    .filter((id) => id.endsWith('@lid') && !this.aliases.has(stripDevice(id)))
                    .map((id) => id),
            )
            .filter((id, index, all) => all.indexOf(id) === index);
    }

    // ── writes ──────────────────────────────────────────────────────────────

    upsertChat(patch: Partial<ChatRecord> & { id: string }): ChatRecord {
        const id = this.canonicalJid(patch.id);
        const existing = this.chats.get(id);
        let chat: ChatRecord = {
            id,
            name: patch.name || existing?.name || '',
            isGroup: patch.isGroup ?? existing?.isGroup ?? id.endsWith('@g.us'),
            unread: patch.unread ?? existing?.unread ?? 0,
            archived: patch.archived ?? existing?.archived ?? false,
            muted: patch.muted ?? existing?.muted ?? false,
            lastMessage: patch.lastMessage ?? existing?.lastMessage ?? '',
            lastTimestamp: patch.lastTimestamp ?? existing?.lastTimestamp ?? 0,
            lastSender: patch.lastSender ?? existing?.lastSender ?? '',
            online: patch.online ?? existing?.online,
            lastSeen: patch.lastSeen ?? existing?.lastSeen,
            avatar: patch.avatar ?? existing?.avatar,
            pinned: patch.pinned ?? existing?.pinned,
        };
        if (!chat.name) chat.name = this.nameFor(chat.id);
        this.chats.set(chat.id, chat);

        // A saved contact or group subject beats the name WhatsApp ships, and a
        // name that is really just a raw LID number is never worth keeping.
        const resolved = this.nameFor(chat.id);
        const stale = !chat.name || isLidName(chat.name) || isLidName(patch.name ?? '');
        if (resolved && (stale || resolved !== chat.name)) {
            chat = { ...chat, name: resolved };
            this.chats.set(chat.id, chat);
        }

        // An unresolved LID has no name to show; use a neutral label rather
        // than echoing its raw digits as if they were a phone number.
        const current = this.chats.get(chat.id);
        if (current && isLidName(current.name)) {
            this.chats.set(chat.id, { ...current, name: this.labelFor(chat.id) });
        }
        this.trimChats();
        this.scheduleSave();
        return chat;
    }

    /** Apply a message to its chat: preview, timestamp, unread count. */
    applyMessage(record: MessageRecord): boolean {
        const message: MessageRecord = { ...record, chatId: this.canonicalJid(record.chatId) };
        const list = this.messages.get(message.chatId) ?? [];
        if (list.some((m) => m.id === message.id)) return false;

        list.push(message);
        if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
        this.messages.set(message.chatId, list);
        this.searchIndex = undefined;

        const existing = this.chats.get(message.chatId);
        const newest = list.reduce((a, b) => (b.timestamp > a.timestamp ? b : a), list[0]);
        this.chats.set(message.chatId, {
            id: message.chatId,
            name: existing?.name || this.nameFor(message.chatId),
            isGroup: message.chatId.endsWith('@g.us'),
            unread: (existing?.unread ?? 0) + (message.isMe ? 0 : 1),
            archived: existing?.archived ?? false,
            muted: existing?.muted ?? false,
            lastMessage: previewOf(newest),
            lastTimestamp: Math.max(newest.timestamp, existing?.lastTimestamp ?? 0),
            lastSender: newest.isMe ? '' : newest.senderName,
            online: existing?.online,
            lastSeen: existing?.lastSeen,
            avatar: existing?.avatar,
            pinned: existing?.pinned,
        });

        this.keys.set(message.chatId, {
            id: message.id,
            isMe: message.isMe,
            senderId: message.senderId,
        });

        this.trimChats();
        this.scheduleSave();
        return true;
    }

    /** Bulk insert from history sync, oldest first per chat. */
    applyHistory(messages: MessageRecord[]): number {
        const byChat = new Map<string, MessageRecord[]>();
        for (const message of messages) {
            const list = byChat.get(message.chatId) ?? [];
            list.push(message);
            byChat.set(message.chatId, list);
        }

        let added = 0;
        for (const [chatId, incoming] of byChat) {
            const existing = this.messages.get(chatId) ?? [];
            const known = new Set(existing.map((m) => m.id));
            const merged = [...existing, ...incoming.filter((m) => !known.has(m.id))].sort(
                (a, b) => a.timestamp - b.timestamp,
            );
            if (merged.length > MAX_MESSAGES_PER_CHAT) {
                merged.splice(0, merged.length - MAX_MESSAGES_PER_CHAT);
            }
            added += merged.length - existing.length;
            this.messages.set(chatId, merged);
            this.searchIndex = undefined;

            const newest = merged[merged.length - 1];
            if (newest) {
                const chat = this.chats.get(chatId);
                this.chats.set(chatId, {
                    id: chatId,
                    name: chat?.name || this.nameFor(chatId),
                    isGroup: chatId.endsWith('@g.us'),
                    unread: chat?.unread ?? 0,
                    archived: chat?.archived ?? false,
                    muted: chat?.muted ?? false,
                    lastMessage: previewOf(newest),
                    lastTimestamp: Math.max(newest.timestamp, chat?.lastTimestamp ?? 0),
                    lastSender: newest.isMe ? '' : newest.senderName,
                    online: chat?.online,
                    lastSeen: chat?.lastSeen,
                    avatar: chat?.avatar,
                    pinned: chat?.pinned,
                });
            }
        }

        this.refreshNames();
        this.trimChats();
        this.scheduleSave();
        return added;
    }

    /** Edit or re-status one message in place. */
    updateMessage(
        chatId: string,
        id: string,
        patch: Partial<Omit<MessageRecord, 'id' | 'chatId'>>,
    ): boolean {
        const cid = this.canonicalJid(chatId);
        const list = this.messages.get(cid);
        const index = list?.findIndex((message) => message.id === id) ?? -1;
        if (!list || index < 0) return false;
        list[index] = { ...list[index], ...patch };
        this.searchIndex = undefined;
        this.refreshPreview(cid);
        this.scheduleSave();
        return true;
    }

    removeMessage(chatId: string, id: string): boolean {
        const cid = this.canonicalJid(chatId);
        const list = this.messages.get(cid);
        const index = list?.findIndex((message) => message.id === id) ?? -1;
        if (!list || index < 0) return false;
        list.splice(index, 1);
        this.searchIndex = undefined;
        this.refreshPreview(cid);
        this.scheduleSave();
        return true;
    }

    /** Apply a delivery/read receipt to the messages you sent. */
    setReceipt(chatId: string, ids: string[], status: 'delivered' | 'read'): boolean {
        const cid = this.canonicalJid(chatId);
        const list = this.messages.get(cid);
        if (!list) return false;

        const rank = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 } as const;
        let changed = false;
        for (const message of list) {
            if (!ids.includes(message.id) || !message.isMe) continue;
            const current = message.status ?? 'sent';
            if (rank[status] <= rank[current]) continue;
            message.status = status;
            changed = true;
        }
        if (!changed) return false;
        this.refreshPreview(cid);
        this.scheduleSave();
        return true;
    }

    /** Record an emoji reaction against the message it belongs to. */
    setReaction(chatId: string, messageId: string, reaction: ReactionRecord): boolean {
        const cid = this.canonicalJid(chatId);
        const list = this.messages.get(cid);
        const message = list?.find((m) => m.id === messageId);
        if (!message) return false;

        const reactions = (message.reactions ?? []).filter(
            (r) => r.senderId !== reaction.senderId,
        );
        if (reaction.text) reactions.push(reaction);
        message.reactions = reactions;
        this.scheduleSave();
        return true;
    }

    setChatPresence(chatId: string, patch: { online?: boolean; lastSeen?: number }): boolean {
        const chat = this.chats.get(chatId);
        if (!chat) return false;
        if (chat.online === patch.online && chat.lastSeen === patch.lastSeen) return false;
        this.chats.set(chatId, { ...chat, ...patch });
        this.scheduleSave();
        return true;
    }

    setAvatar(chatId: string, avatar: string | undefined): boolean {
        const chat = this.chats.get(chatId);
        if (!chat || chat.avatar === avatar) return false;
        this.chats.set(chatId, { ...chat, avatar });
        this.scheduleSave();
        return true;
    }

    setPinned(chatId: string, pinned: boolean): boolean {
        const chat = this.chats.get(chatId);
        if (!chat) return false;
        this.chats.set(chatId, { ...chat, pinned });
        this.scheduleSave();
        return true;
    }

    setMuted(chatId: string, muted: boolean): boolean {
        const chat = this.chats.get(chatId);
        if (!chat || Boolean(chat.muted) === muted) return false;
        this.chats.set(chatId, { ...chat, muted });
        this.scheduleSave();
        return true;
    }

    setContacts(contacts: ContactRecord[]): void {
        let changed = false;
        for (const contact of contacts) {
            const existing = this.contacts.get(contact.id);
            const merged = { ...existing, ...contact };
            this.contacts.set(contact.id, merged);

            // A contact addressed by LID still tells us its phone number.
            if (contact.id.endsWith('@lid') && contact.phone) {
                changed = this.setAlias(contact.id, contact.phone) || changed;
            }
            if (
                existing &&
                existing.name === merged.name &&
                existing.notify === merged.notify &&
                existing.phone === merged.phone &&
                existing.username === merged.username
            ) {
                continue;
            }
            changed = true;
        }
        if (!changed) return;
        this.seedAliasContacts();
        this.rekeyLidChats();
        this.refreshNames();
        this.scheduleSave();
    }

    /** Learn LID → phone mappings from history sync. */
    setAliases(pairs: Array<{ lid?: string | null; pn?: string | null }>): void {
        let changed = false;
        for (const pair of pairs) {
            if (!pair.lid || !pair.pn) continue;
            changed = this.setAlias(pair.lid, pair.pn) || changed;
        }
        if (!changed) return;
        this.seedAliasContacts();
        this.rekeyLidChats();
        this.refreshNames();
        this.scheduleSave();
    }

    /**
     * Bulk-learn aliases from Baileys' own on-disk `lid-mapping` files.
     *
     * This is the fix for chats that show up as `+254034497798362`: WhatsApp
     * addresses those contacts by LID, and the phone number lives in the
     * linked-device auth folder even when the live socket never hands us a
     * `lidPnMappings` entry. Reading it once at startup resolves every contact
     * that was ever mapped, not just the ones that messaged us this session.
     */
    learnAliasesFromDisk(authDir: string): number {
        let files: string[];
        try {
            files = fs.readdirSync(authDir);
        } catch {
            return 0;
        }

        let learned = 0;
        for (const file of files) {
            if (!file.startsWith('lid-mapping-') || !file.endsWith('.json')) continue;
            const reverse = file.endsWith('_reverse.json');
            const user = file
                .slice('lid-mapping-'.length, file.length - '.json'.length)
                .replace(/_reverse$/, '');
            if (!/^\d+$/.test(user)) continue;

            let value: unknown;
            try {
                value = JSON.parse(fs.readFileSync(path.join(authDir, file), 'utf8'));
            } catch {
                continue;
            }
            if (typeof value !== 'string' || !/^\d+$/.test(value)) continue;

            // `lid-mapping-<lid>_reverse.json` holds the PN; the plain file
            // holds the LID for a PN. Both directions are the same fact.
            const lid = reverse ? user : value;
            const pn = reverse ? value : user;
            if (this.setAlias(`${lid}@lid`, `${pn}@s.whatsapp.net`)) learned += 1;
        }

        if (learned > 0) {
            this.seedAliasContacts();
            this.rekeyLidChats();
            this.refreshNames();
            this.scheduleSave();
        }
        return learned;
    }

    /** Make a LID contact's name answer for its phone-number JID too. */
    private seedAliasContacts(): void {
        for (const contact of [...this.contacts.values()]) {
            if (!contact.phone) continue;
            const pn = stripDevice(contact.phone);
            const target = this.contacts.get(pn);
            const name = target?.name || contact.name;
            const notify = target?.notify || contact.notify;
            const username = target?.username || contact.username;
            if (
                target &&
                target.name === name &&
                target.notify === notify &&
                target.username === username
            ) {
                continue;
            }
            this.contacts.set(pn, { id: pn, name, notify, phone: pn, username });
        }
    }

    /** Move a chat stored under a LID JID onto the phone-number JID. */
    private rekeyLidChats(): void {
        for (const [id, chat] of [...this.chats]) {
            if (!id.endsWith('@lid')) continue;
            const target = this.canonicalJid(id);
            if (target === id) continue;

            const messages = this.messages.get(id) ?? [];
            const existing = this.chats.get(target);
            const name = chat.name && !isLidName(chat.name) ? chat.name : this.nameFor(target);

            if (existing) {
                const merged = [...(this.messages.get(target) ?? []), ...messages]
                    .sort((a, b) => a.timestamp - b.timestamp)
                    .filter(
                        (message, index, list) =>
                            list.findIndex((m) => m.id === message.id) === index,
                    );
                if (merged.length > MAX_MESSAGES_PER_CHAT) {
                    merged.splice(0, merged.length - MAX_MESSAGES_PER_CHAT);
                }
                this.messages.set(target, merged);
                this.searchIndex = undefined;

                const newest = merged[merged.length - 1];
                this.chats.set(target, {
                    ...existing,
                    name:
                        existing.name && !isLidName(existing.name)
                            ? existing.name
                            : name || existing.name,
                    unread: Math.max(existing.unread, chat.unread),
                    lastMessage: newest ? previewOf(newest) : existing.lastMessage,
                    lastTimestamp: Math.max(existing.lastTimestamp, chat.lastTimestamp),
                    lastSender: newest
                        ? newest.isMe
                            ? ''
                            : newest.senderName
                        : existing.lastSender,
                });
            } else {
                this.messages.set(target, messages);
                this.searchIndex = undefined;
                this.chats.set(target, {
                    ...chat,
                    id: target,
                    name: name || formatPhone(target),
                    isGroup: false,
                });
            }

            this.messages.delete(id);
            this.searchIndex = undefined;
            this.chats.delete(id);
            this.keys.delete(id);
        }
    }

    private setAlias(lid: string, pn: string): boolean {
        const key = stripDevice(lid);
        const target = stripDevice(pn);
        if (!key.endsWith('@lid') || !target || key === target) return false;
        if (this.aliases.get(key) === target) return false;
        this.aliases.set(key, target);
        return true;
    }

    setGroups(groups: GroupRecord[]): void {
        for (const group of groups) {
            this.groups.set(group.id, { ...this.groups.get(group.id), ...group });
        }
        this.refreshNames();
        this.scheduleSave();
    }

    clearUnread(chatId: string): boolean {
        const chat = this.chats.get(chatId);
        if (!chat || chat.unread === 0) return false;
        this.chats.set(chatId, { ...chat, unread: 0 });
        this.scheduleSave();
        return true;
    }

    clear(): void {
        this.chats.clear();
        this.messages.clear();
        this.searchIndex = undefined;
        this.contacts.clear();
        this.groups.clear();
        this.keys.clear();
        this.aliases.clear();
        this.scheduleSave();
    }

    // ── persistence ─────────────────────────────────────────────────────────

    /** Keep a chat's preview in step after an edit, delete or receipt. */
    private refreshPreview(chatId: string): void {
        const chat = this.chats.get(chatId);
        const list = this.messages.get(chatId);
        if (!chat || !list?.length) return;
        const newest = list.reduce((a, b) => (b.timestamp > a.timestamp ? b : a), list[0]);
        this.chats.set(chatId, {
            ...chat,
            lastMessage: previewOf(newest),
            lastTimestamp: Math.max(newest.timestamp, chat.lastTimestamp),
            lastSender: newest.isMe ? '' : newest.senderName,
        });
    }

    private refreshNames(): void {
        for (const [id, chat] of this.chats) {
            const resolved = this.nameFor(id);
            if (resolved && resolved !== chat.name) this.chats.set(id, { ...chat, name: resolved });
        }
    }

    private trimChats(): void {
        if (this.chats.size <= MAX_CHATS) return;
        const keep = this.listChats({ includeArchived: true }).slice(0, MAX_CHATS);
        const keepIds = new Set(keep.map((chat) => chat.id));
        for (const id of [...this.chats.keys()]) {
            if (!keepIds.has(id)) {
                this.chats.delete(id);
                this.messages.delete(id);
                this.searchIndex = undefined;
                this.keys.delete(id);
            }
        }
    }

    private scheduleSave(): void {
        this.dirty = true;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), 500);
    }

    save(): void {
        if (!this.dirty) return;
        this.dirty = false;
        const data: Snapshot = {
            version: 4,
            chats: [...this.chats.values()],
            messages: Object.fromEntries(this.messages),
            contacts: [...this.contacts.values()].slice(0, MAX_CONTACTS),
            groups: [...this.groups.values()],
            keys: Object.fromEntries(this.keys),
            aliases: Object.fromEntries(this.aliases),
        };
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
            fs.renameSync(tmp, this.file);
        } catch {
            // Losing the local mirror must never break messaging.
        }
    }

    dispose(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.save();
    }
}

/**
 * A chat named after a raw LID or phone number is not a name worth keeping.
 *
 * Matches `254034497798362`, `+254034497798362` and `254 034 497 798 362`, but
 * never a real name that merely contains digits.
 */
function isLidName(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return /^\+?[\d\s()-]{8,}$/.test(trimmed) && /\d{8,}/.test(trimmed.replace(/\D/g, ''));
}

function previewOf(message: MessageRecord): string {
    if (message.deleted) return 'Message deleted';
    return message.text;
}

export function formatPhone(jid: string): string {
    const digits = stripDevice(jid).split('@')[0].replace(/\D/g, '');
    return digits ? `+${digits}` : jid;
}

export function stripDevice(jid: string): string {
    const [user, server] = jid.split('@');
    if (!server) return user.split(':')[0];
    return `${user.split(':')[0]}@${server}`;
}