import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    downloadMediaMessage,
    type proto,
    type WAMessage,
} from 'baileys';
import type { MessageRecord } from './types';

const MAX_FILE_BYTES = 16 * 1024 * 1024;

type MediaContent =
    | proto.Message.IImageMessage
    | proto.Message.IVideoMessage
    | proto.Message.IAudioMessage
    | proto.Message.IDocumentMessage
    | proto.Message.IStickerMessage;

/**
 * Downloads media once and keeps it on disk.
 *
 * WhatsApp media links expire, so a message that is not downloaded when it
 * arrives may never be downloadable again. The cache is keyed by message id,
 * which means a restart does not re-download anything.
 */
export class MediaCache {
    private readonly root: string;
    private readonly inflight = new Map<string, Promise<string | undefined>>();

    constructor(
        root: string,
        private readonly log: (message: string) => void = () => undefined,
    ) {
        this.root = root;
        try {
            fs.mkdirSync(this.root, { recursive: true });
        } catch (err) {
            this.log(`Media cache unavailable: ${err instanceof Error ? err.message : err}`);
        }
    }

    /**
     * Make sure a message's media is on disk, and return the file path.
     *
     * Resolves to `undefined` when the message has no media, when the download
     * is not possible (expired link, network down), or when it is too large.
     * Never throws: a missing photo must not break the inbox.
     */
    async ensure(raw: WAMessage, record: MessageRecord): Promise<string | undefined> {
        if (record.kind === 'text' || record.kind === 'system' || record.kind === 'other') {
            return undefined;
        }
        if (record.media?.file && fs.existsSync(record.media.file)) return record.media.file;
        if (record.media?.failed) return undefined;

        const existing = this.inflight.get(record.id);
        if (existing) return existing;

        const task = this.download(raw, record);
        this.inflight.set(record.id, task);
        try {
            return await task;
        } finally {
            this.inflight.delete(record.id);
        }
    }

    /** Path for a cached avatar, downloading it on first request. */
    async avatar(url: string, jid: string): Promise<string | undefined> {
        const safe = jid.replace(/[^\w.@-]/g, '_');
        const file = path.join(this.root, `avatar-${safe}.jpg`);
        if (fs.existsSync(file)) return file;
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) return undefined;
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) return undefined;
            fs.writeFileSync(file, buffer);
            return file;
        } catch {
            return undefined;
        }
    }

    private async download(raw: WAMessage, record: MessageRecord): Promise<string | undefined> {
        const content = mediaContent(raw.message);
        if (!content) return undefined;

        const length = Number((content as { fileLength?: unknown }).fileLength ?? 0);
        if (length > MAX_FILE_BYTES) {
            this.log(`Skipping ${record.kind} ${record.id}: ${Math.round(length / 1024)} KB is too large`);
            return undefined;
        }

        const extension = extensionFor(record.kind, record.media?.mimetype);
        const file = path.join(this.root, `${safeName(record.id)}${extension}`);

        try {
            const buffer = await downloadMediaMessage(
                raw,
                'buffer',
                {},
                {
                    logger: silentMediaLogger,
                    reuploadRequest: async (message) => message,
                },
            );
            if (!buffer || buffer.length === 0) return undefined;
            fs.writeFileSync(file, buffer);
            this.log(`Cached ${record.kind} for ${record.id} (${Math.round(buffer.length / 1024)} KB)`);
            return file;
        } catch (err) {
            this.log(`Media download failed for ${record.id}: ${err instanceof Error ? err.message : err}`);
            return undefined;
        }
    }
}

/** The media payload inside a message, if it is one. */
function mediaContent(message: proto.IMessage | null | undefined): MediaContent | undefined {
    if (!message) return undefined;
    return (
        message.imageMessage ??
        message.videoMessage ??
        message.audioMessage ??
        message.documentMessage ??
        message.stickerMessage ??
        message.ptvMessage ??
        undefined
    );
}

function extensionFor(kind: MessageRecord['kind'], mimetype?: string): string {
    if (mimetype) {
        const subtype = mimetype.split('/')[1]?.split(';')[0];
        if (subtype === 'jpeg') return '.jpg';
        if (subtype === 'svg+xml') return '.svg';
        if (subtype && /^[\w.+-]+$/.test(subtype)) return `.${subtype}`;
    }
    switch (kind) {
        case 'image':
            return '.jpg';
        case 'video':
            return '.mp4';
        case 'audio':
            return '.ogg';
        case 'sticker':
            return '.webp';
        default:
            return '.bin';
    }
}

function safeName(id: string): string {
    const digest = crypto.createHash('sha1').update(id).digest('hex');
    return digest.slice(0, 24);
}

/** Baileys wants a logger for re-upload; ours is intentionally quiet. */
const silentMediaLogger = {
    level: 'silent',
    child: () => silentMediaLogger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

