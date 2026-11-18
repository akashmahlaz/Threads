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
    | 'call'
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
    /** True while this person is online right now. */
    online?: boolean;
    /** Epoch ms of their last "last seen", when WhatsApp shares it. */
    lastSeen?: number;
    /** Cached profile photo, as a `webview://` URL. */
    avatar?: string;
    /** The user pinned this chat. */
    pinned?: boolean;
}

export interface ReactionRecord {
    /** Emoji, or an empty string when the reaction was removed. */
    text: string;
    senderId: string;
    senderName: string;
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
    quoted?: { text: string; senderName: string; senderId?: string };
    /** Media details worth showing without downloading the bytes. */
    media?: {
        mimetype?: string;
        fileName?: string;
        seconds?: number;
        /** Local file the bytes were downloaded to. */
        file?: string;
        /** True once the download was attempted and failed. */
        failed?: boolean;
        /** Original dimensions, for images and video. */
        width?: number;
        height?: number;
    };
    /** Delivery state, for messages you sent. */
    status?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
    /** The sender edited this message after sending it. */
    edited?: boolean;
    /** The sender deleted this message for everyone. */
    deleted?: boolean;
    /** Emoji reactions on this message, keyed by sender. */
    reactions?: ReactionRecord[];
    /** The message is a forwarded copy. */
    forwarded?: boolean;
    /** Poll options, when `kind` is `poll`. */
    poll?: { question: string; options: string[] };
}

export interface ContactRecord {
    id: string;
    /** Address-book name. */
    name?: string;
    /** Name the contact set for themselves (push name). */
    notify?: string;
    /** Phone-number JID when the contact is addressed by LID. */
    phone?: string;
    /** WhatsApp username (`@handle`), when the account has one. */
    username?: string;
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