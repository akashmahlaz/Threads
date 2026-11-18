export type MessageKind =
    | 'text'
    | 'image'
    | 'video'
    | 'audio'
    | 'document'
    | 'sticker'
    | 'location'
    | 'contact'
    | 'poll'
    | 'system'
    | 'other';

export interface ChatRecord {
    /** WhatsApp JID: `15551234567@s.whatsapp.net`, `…@lid` or `123456789@g.us`. */
    id: string;
    name: string;
    isGroup: boolean;
    unread: number;
    archived: boolean;
    muted: boolean;
    /** Human-readable preview of the newest message. */
    lastMessage: string;
    /** Milliseconds since epoch. */
    lastTimestamp: number;
    /** Who wrote the newest message (groups). */
    lastSender: string;
}

export interface MessageRecord {
    id: string;
    chatId: string;
    /** Text, caption, or a short summary such as `Photo` or `Voice message (0:07)`. */
    text: string;
    kind: MessageKind;
    senderId: string;
    senderName: string;
    isMe: boolean;
    /** Milliseconds since epoch. */
    timestamp: number;
    quoted?: { text: string; senderName: string };
    /** Media details worth showing without downloading the bytes. */
    media?: { mimetype?: string; fileName?: string; seconds?: number };
    /** Delivery state, for messages you sent. */
    status?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
    /** The sender edited this message after sending it. */
    edited?: boolean;
    /** The sender deleted this message for everyone. */
    deleted?: boolean;
}

export interface ContactRecord {
    id: string;
    /** Address-book name. */
    name?: string;
    /** Name the contact set for themselves (push name). */
    notify?: string;
    /** Phone-number JID when the contact is addressed by LID. */
    phone?: string;
}

export interface GroupRecord {
    id: string;
    subject: string;
    members: number;
    /** Group description, if any. */
    description?: string;
}

/** The key needed to mark a message read on the phone. */
export interface MessageKeyRef {
    id: string;
    isMe: boolean;
    senderId?: string;
}
