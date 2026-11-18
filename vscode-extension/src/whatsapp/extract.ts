import { isJidGroup, normalizeMessageContent, type proto, type WAMessage } from 'baileys';
import type { MessageKind, MessageRecord } from './types';

export interface ExtractContext {
    /** JID of the linked account, used to attribute your own messages. */
    selfJid: string;
    nameFor(jid: string, pushName?: string): string;
}

/**
 * Turn a raw WhatsApp message into what the inbox shows and Copilot reads.
 *
 * Returning `null` is important: WhatsApp's protocol carries a lot of traffic
 * that is not a chat message — sender-key distribution, protocol stanzas,
 * undecryptable ciphertext, receipts. Those used to show up as
 * "[unsupported message]".
 */
export function extractMessage(raw: WAMessage, ctx: ExtractContext): MessageRecord | null {
    const chatId = raw.key?.remoteJid;
    if (!chatId) return null;
    if (!isSupportedChat(chatId)) return null;

    const content = unwrap(raw.message);
    const stub = content ? null : stubText(raw);
    if (!content && !stub) return null;

    const isGroup = isJidGroup(chatId);
    const isMe = raw.key.fromMe === true;
    const senderId = isMe
        ? ctx.selfJid
        : isGroup
          ? (raw.key.participant ?? chatId)
          : chatId;
    const senderName = isMe ? 'You' : ctx.nameFor(senderId, raw.pushName ?? undefined);

    const described = content ? describe(content, raw) : { text: stub as string, kind: 'system' as const };
    if (!described) return null;

    const timestamp = toMillis(raw.messageTimestamp);
    const quoted = content ? describeQuote(content, ctx) : undefined;

    return {
        id: raw.key.id ?? `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        text: described.text,
        kind: described.kind,
        senderId,
        senderName,
        isMe,
        timestamp,
        quoted,
        media: described.media,
        poll: described.poll,
        forwarded: content && isForwarded(content) ? true : undefined,
    };
}

export function isSupportedChat(jid: string): boolean {
    if (jid === 'status@broadcast') return false;
    if (jid.endsWith('@broadcast')) return false;
    if (jid.endsWith('@newsletter')) return false;
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@g.us');
}

/** Peel the wrappers WhatsApp adds around real content. */
function unwrap(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
    let content = normalizeMessageContent(message ?? undefined) ?? undefined;
    const seen = new Set<proto.IMessage>();

    for (let depth = 0; content && depth < 5; depth += 1) {
        if (seen.has(content)) break;
        seen.add(content);

        if (content.deviceSentMessage?.message) {
            content = normalizeMessageContent(content.deviceSentMessage.message) ?? undefined;
            continue;
        }
        if (content.editedMessage?.message) {
            content = normalizeMessageContent(content.editedMessage.message) ?? undefined;
            continue;
        }
        break;
    }

    if (!content) return undefined;
    // Traffic that is not a user-visible message.
    if (!contentType(content)) return undefined;
    if (content.senderKeyDistributionMessage || content.protocolMessage) return undefined;
    // Reactions arrive on their own event; a reaction *message* is noise here.
    if (content.reactionMessage) return undefined;
    return content;
}

function contentType(content: proto.IMessage): keyof proto.IMessage | undefined {
    return (Object.keys(content) as Array<keyof proto.IMessage>).find(
        (key) =>
            key !== 'messageContextInfo' &&
            key !== 'senderKeyDistributionMessage' &&
            content[key] != null,
    );
}

interface Described {
    text: string;
    kind: MessageKind;
    media?: MessageRecord['media'];
    poll?: MessageRecord['poll'];
}

function describe(content: proto.IMessage, raw: WAMessage): Described | null {
    const c = content;

    if (c.conversation) return { text: c.conversation, kind: 'text' };
    if (c.extendedTextMessage?.text) {
        return { text: c.extendedTextMessage.text, kind: 'text' };
    }
    if (c.extendedTextMessage?.matchedText) {
        return { text: c.extendedTextMessage.matchedText, kind: 'text' };
    }

    if (c.imageMessage) {
        const caption = c.imageMessage.caption?.trim();
        return {
            text: caption || 'Photo',
            kind: 'image',
            media: {
                mimetype: c.imageMessage.mimetype ?? undefined,
                width: c.imageMessage.width ?? undefined,
                height: c.imageMessage.height ?? undefined,
            },
        };
    }
    if (c.videoMessage) {
        const caption = c.videoMessage.caption?.trim();
        const seconds = c.videoMessage.seconds ?? undefined;
        return {
            text: caption || (c.videoMessage.gifPlayback ? 'GIF' : withDuration('Video', seconds)),
            kind: 'video',
            media: {
                mimetype: c.videoMessage.mimetype ?? undefined,
                seconds,
                width: c.videoMessage.width ?? undefined,
                height: c.videoMessage.height ?? undefined,
            },
        };
    }
    if (c.ptvMessage) {
        return { text: 'Video message', kind: 'video', media: { seconds: c.ptvMessage.seconds ?? undefined } };
    }
    if (c.audioMessage) {
        const seconds = c.audioMessage.seconds ?? undefined;
        return {
            text: withDuration(c.audioMessage.ptt ? 'Voice message' : 'Audio', seconds),
            kind: 'audio',
            media: { mimetype: c.audioMessage.mimetype ?? undefined, seconds },
        };
    }
    if (c.documentMessage) {
        const name = c.documentMessage.fileName ?? 'Document';
        const caption = c.documentMessage.caption?.trim();
        return {
            text: caption ? `${name} — ${caption}` : name,
            kind: 'document',
            media: {
                mimetype: c.documentMessage.mimetype ?? undefined,
                fileName: c.documentMessage.fileName ?? undefined,
                seconds: undefined,
            },
        };
    }
    if (c.stickerMessage) return { text: 'Sticker', kind: 'sticker' };
    if (c.locationMessage) {
        const loc = c.locationMessage;
        const label =
            loc.name || loc.address || `${loc.degreesLatitude ?? 0}, ${loc.degreesLongitude ?? 0}`;
        return { text: `Location: ${label}`, kind: 'location' };
    }
    if (c.liveLocationMessage) return { text: 'Live location', kind: 'location' };
    if (c.contactMessage?.displayName) {
        return { text: `Contact: ${c.contactMessage.displayName}`, kind: 'contact' };
    }
    if (c.contactsArrayMessage) {
        return {
            text: `Contacts: ${c.contactsArrayMessage.contacts?.length ?? 0}`,
            kind: 'contact',
        };
    }
    if (c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3) {
        const poll = c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3;
        const question = poll?.name ?? '';
        const options = (poll?.options ?? [])
            .map((option) => option.optionName ?? '')
            .filter((name): name is string => Boolean(name));
        return {
            text: question ? `Poll: ${question}` : 'Poll',
            kind: 'poll',
            poll: { question, options },
        };
    }
    if (c.callLogMesssage) {
        const log = c.callLogMesssage;
        const kind = log.isVideo ? 'Video call' : 'Voice call';
        const outcome = callOutcomeName(log.callOutcome);
        const duration = toSeconds(log.durationSecs);
        return {
            text: [kind, outcome, duration ? withDuration('', duration) : '']
                .filter(Boolean)
                .join(' · '),
            kind: 'call',
        };
    }
    if (c.eventMessage?.name) return { text: `Event: ${c.eventMessage.name}`, kind: 'other' };
    if (c.groupInviteMessage?.groupName) {
        return { text: `Group invite: ${c.groupInviteMessage.groupName}`, kind: 'other' };
    }
    if (c.buttonsResponseMessage) {
        return {
            text: c.buttonsResponseMessage.selectedDisplayText ?? 'Button reply',
            kind: 'text',
        };
    }
    if (c.listResponseMessage) {
        return { text: c.listResponseMessage.title ?? 'List reply', kind: 'text' };
    }
    if (c.templateButtonReplyMessage?.selectedDisplayText) {
        return { text: c.templateButtonReplyMessage.selectedDisplayText, kind: 'text' };
    }
    if (c.albumMessage) return { text: 'Album', kind: 'other' };

    // Group activity that WhatsApp sends as a message stub.
    const stub = stubText(raw);
    if (stub) return { text: stub, kind: 'system' };

    return null;
}

function stubText(raw: WAMessage): string | null {
    const type = raw.messageStubType;
    if (!type) return null;
    const params = (raw.messageStubParameters ?? []) as string[];
    switch (type) {
        case 1:
            return 'Message deleted';
        case 2:
            return null; // ciphertext we cannot read
        case 9:
            return 'Group created';
        case 10:
            return params[0] ? `Group named "${params[0]}"` : 'Group renamed';
        case 11:
            return 'Group icon changed';
        case 12:
            return 'Group description changed';
        case 13:
            return 'Group settings changed';
        case 14:
            return params[0] ? `${params[0]} joined` : 'Participant joined';
        case 15:
            return params[0] ? `${params[0]} left` : 'Participant left';
        case 16:
            return params[0] ? `${params[0]} was removed` : 'Participant removed';
        case 17:
            return 'You were added';
        default:
            return null;
    }
}

function describeQuote(
    content: proto.IMessage,
    ctx: ExtractContext,
): MessageRecord['quoted'] | undefined {
    const context = firstContextInfo(content);
    const quoted = context?.quotedMessage;
    if (!quoted) return undefined;

    const unwrapped = normalizeMessageContent(quoted) ?? quoted;
    const text =
        unwrapped.conversation ||
        unwrapped.extendedTextMessage?.text ||
        unwrapped.imageMessage?.caption ||
        unwrapped.videoMessage?.caption ||
        (unwrapped.imageMessage ? 'Photo' : undefined) ||
        (unwrapped.audioMessage ? 'Voice message' : undefined) ||
        (unwrapped.documentMessage?.fileName ?? undefined) ||
        (unwrapped.stickerMessage ? 'Sticker' : undefined) ||
        (unwrapped.pollCreationMessage?.name ?? undefined) ||
        (unwrapped.locationMessage?.name ?? undefined);
    if (!text) return undefined;

    const participant = context?.participant ?? undefined;
    return {
        text,
        senderName: participant ? ctx.nameFor(participant) : '',
        senderId: participant ?? undefined,
    };
}

function firstContextInfo(content: proto.IMessage): proto.IContextInfo | undefined {
    for (const value of Object.values(content)) {
        const context = (value as { contextInfo?: proto.IContextInfo } | null)?.contextInfo;
        if (context) return context;
    }
    return undefined;
}

function isForwarded(content: proto.IMessage): boolean {
    return Boolean(firstContextInfo(content)?.isForwarded);
}

function callOutcomeName(outcome: proto.Message.CallLogMessage.CallOutcome | null | undefined): string {
    switch (outcome) {
        case 0:
            return 'completed';
        case 1:
            return 'missed';
        case 2:
            return 'failed';
        case 3:
            return 'declined';
        case 4:
            return 'answered elsewhere';
        case 5:
            return 'ongoing';
        case 6:
            return 'silenced';
        case 7:
            return 'silenced (unknown caller)';
        default:
            return '';
    }
}

function withDuration(label: string, seconds?: number | null): string {
    if (!seconds) return label;
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (!label) return `${minutes}:${String(rest).padStart(2, '0')}`;
    return `${label} (${minutes}:${String(rest).padStart(2, '0')})`;
}

function toSeconds(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const numberLike = value as { toNumber?: () => number };
    if (typeof numberLike.toNumber === 'function') return numberLike.toNumber();
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function toMillis(timestamp: WAMessage['messageTimestamp']): number {
    if (!timestamp) return Date.now();
    if (typeof timestamp === 'number') return timestamp * 1000;
    const value = timestamp as { toNumber?: () => number };
    if (typeof value.toNumber === 'function') return value.toNumber() * 1000;
    return Number(timestamp) * 1000;
}