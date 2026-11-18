import * as fs from 'fs';
import * as path from 'path';
import type {
    ChatRecord,
    ContactRecord,
    GroupRecord,
    MessageKeyRef,
    MessageRecord,
} from './types';

const MAX_CHATS = 500;
const MAX_MESSAGES_PER_CHAT = 60;

interface Snapshot {
    version: 2 | 3;
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
    private saveTimer?: NodeJS.Timeout;

    constructor(private readonly file: string) {}

    load(): void {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Snapshot;
            // v1 was written by the Chat SDK adapter build; its chat list is
            // noise, so start clean rather than migrate it.
            if (data.version !== 2 && data.version !== 3) return;
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
            .sort((a, b) => (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0));
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

    search(query: string, limit = 50): Array<{ chat: ChatRecord; message: MessageRecord }> {
        const needle = query.toLowerCase();
        const hits: Array<{ chat: ChatRecord; message: MessageRecord }> = [];
        for (const [chatId, list] of this.messages) {
            const chat = this.chats.get(chatId);
            if (!chat) continue;
            for (const message of list) {
                if (message.text.toLowerCase().includes(needle)) {
                    hits.push({ chat, message });
                    if (hits.length >= limit) return hits;
                }
            }
        }
        return hits;
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
        const chat = this.chats.get(canonical) ?? this.chats.get(jid);
        return (
            saved ||
            chat?.name ||
            (contact?.phone ? formatPhone(contact.phone) : '') ||
            pushName ||
            (canonical.endsWith('@g.us') ? 'Group' : formatPhone(canonical))
        );
    }

    /**
     * WhatsApp addresses some contacts by LID (`…@lid`). When the phone-number
     * JID is known, use it so one person is one chat and the title is a number
     * rather than an opaque identifier.
     */
    canonicalJid(jid: string): string {
        let current = stripDevice(jid);
        for (let hop = 0; hop < 3; hop += 1) {
            const next = this.aliases.get(current);
            if (!next || next === current) break;
            current = stripDevice(next);
        }
        return current;
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
        };
        if (!chat.name) chat.name = this.nameFor(chat.id);
        this.chats.set(chat.id, chat);

        // A saved contact or group subject beats the name WhatsApp ships.
        const resolved = this.nameFor(chat.id);
        if (resolved && resolved !== chat.name) {
            chat = { ...chat, name: resolved };
            this.chats.set(chat.id, chat);
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
            if (existing && existing.name === merged.name && existing.notify === merged.notify) continue;
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

    /** Make a LID contact's name answer for its phone-number JID too. */
    private seedAliasContacts(): void {
        for (const contact of [...this.contacts.values()]) {
            if (!contact.phone) continue;
            const pn = stripDevice(contact.phone);
            const target = this.contacts.get(pn);
            const name = target?.name || contact.name;
            const notify = target?.notify || contact.notify;
            if (target && target.name === name && target.notify === notify) continue;
            this.contacts.set(pn, { id: pn, name, notify, phone: pn });
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
                    .filter((message, index, list) => list.findIndex((m) => m.id === message.id) === index);
                if (merged.length > MAX_MESSAGES_PER_CHAT) {
                    merged.splice(0, merged.length - MAX_MESSAGES_PER_CHAT);
                }
                this.messages.set(target, merged);

                const newest = merged[merged.length - 1];
                this.chats.set(target, {
                    ...existing,
                    name: existing.name && !isLidName(existing.name) ? existing.name : name || existing.name,
                    unread: Math.max(existing.unread, chat.unread),
                    lastMessage: newest ? previewOf(newest) : existing.lastMessage,
                    lastTimestamp: Math.max(existing.lastTimestamp, chat.lastTimestamp),
                    lastSender: newest ? (newest.isMe ? '' : newest.senderName) : existing.lastSender,
                });
            } else {
                this.messages.set(target, messages);
                this.chats.set(target, {
                    ...chat,
                    id: target,
                    name: name || formatPhone(target),
                    isGroup: false,
                });
            }

            this.messages.delete(id);
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
                this.keys.delete(id);
            }
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), 500);
    }

    save(): void {
        const data: Snapshot = {
            version: 3,
            chats: [...this.chats.values()],
            messages: Object.fromEntries(this.messages),
            contacts: [...this.contacts.values()],
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

/** A chat named after a raw LID number is not a name worth keeping. */
function isLidName(name: string): boolean {
    return /^@?\d{8,}$/.test(name.replace(/[\s()+-]/g, ''));
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
