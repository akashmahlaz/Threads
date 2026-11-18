import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type SoundName = 'message' | 'group' | 'mention';

/**
 * Plays a short chime when a message arrives.
 *
 * VS Code has no API for this — `vscode.window.showInformationMessage` has no
 * sound option, and a webview's `Audio` object is blocked by autoplay policy
 * and suspended when the sidebar is hidden, which is exactly when a chime
 * matters. So the extension host shells out to the OS instead: it works with
 * the window in the background and with the sidebar closed.
 */
export class SoundPlayer {
    private readonly cacheDir: string;
    private cache = new Map<SoundName, string>();
    /** Serialises plays so a burst of messages does not overlap into noise. */
    private queue: Promise<void> = Promise.resolve();
    private lastPlayed = 0;

    constructor(
        cacheDir: string,
        private readonly log: (message: string) => void = () => undefined,
    ) {
        this.cacheDir = cacheDir;
        try {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        } catch {
            // A missing cache directory just means we fall back to the beep.
        }
    }

    /**
     * Play a chime. `kind` picks the tone; failures are logged and swallowed,
     * because a sound must never break message delivery.
     */
    play(kind: SoundName = 'message'): void {
        const now = Date.now();
        // Chat clients coalesce bursts; one chime per 400 ms is plenty.
        if (now - this.lastPlayed < 400) return;
        this.lastPlayed = now;

        this.queue = this.queue.then(async () => {
            try {
                await this.playNow(kind);
            } catch (err) {
                this.log(`Sound failed: ${err instanceof Error ? err.message : err}`);
            }
        });
    };

    private async playNow(kind: SoundName): Promise<void> {
        const file = await this.tone(kind);
        if (file) {
            await this.playFile(file);
            return;
        }
        await this.fallback();
    }

    /** Write the chime to disk once, then reuse it. */
    private async tone(kind: SoundName): Promise<string | undefined> {
        const existing = this.cache.get(kind);
        if (existing && fs.existsSync(existing)) return existing;

        const file = path.join(this.cacheDir, `${kind}.wav`);
        try {
            if (!fs.existsSync(file)) fs.writeFileSync(file, renderTone(kind));
            this.cache.set(kind, file);
            return file;
        } catch (err) {
            this.log(`Could not write ${kind} tone: ${err instanceof Error ? err.message : err}`);
            return undefined;
        }
    }

    private async playFile(file: string): Promise<void> {
        if (process.platform === 'darwin') {
            await execFileAsync('afplay', [file]);
            return;
        }
        if (process.platform === 'win32') {
            await execFileAsync('powershell', [
                '-NoProfile',
                '-Command',
                `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
            ]);
            return;
        }
        // Linux: try the common players in order, ignore the ones that are absent.
        for (const [command, args] of [
            ['paplay', [file]],
            ['aplay', ['-q', file]],
            ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]],
        ] as Array<[string, string[]]>) {
            try {
                await execFileAsync(command, args);
                return;
            } catch {
                // Try the next player.
            }
        }
        await this.fallback();
    }

    /** Last resort: the terminal bell, via the OS. */
    private async fallback(): Promise<void> {
        if (process.platform === 'darwin') {
            await execFileAsync('afplay', ['/System/Library/Sounds/Glass.aiff']).catch(() => undefined);
            return;
        }
        if (process.platform === 'win32') {
            await execFileAsync('powershell', [
                '-NoProfile',
                '-Command',
                '[console]::beep(880,200)',
            ]).catch(() => undefined);
            return;
        }
        process.stdout.write('\u0007');
    }
}

/**
 * Render a short two-tone chime as a 16-bit mono WAV.
 *
 * Generating it means the extension ships no binary audio and no copyrighted
 * sample, and the tone can differ per event kind.
 */
function renderTone(kind: SoundName): Buffer {
    const sampleRate = 22_050;
    // Work in whole samples per note: rounding each note up and then summing
    // the rounded values can overflow the buffer by a sample or two.
    const notes = notesFor(kind).map(
        ([frequency, ms]) => [frequency, Math.round((sampleRate * ms) / 1000)] as const,
    );
    const samples = notes.reduce((sum, [, count]) => sum + count, 0);
    const dataSize = samples * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16); // PCM chunk size
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);

    let offset = 44;
    for (const [frequency, count] of notes) {
        for (let i = 0; i < count; i += 1) {
            const t = i / sampleRate;
            // A short fade in and out keeps the chime from clicking.
            const envelope = Math.min(1, i / 200, (count - i) / 400);
            const wave =
                Math.sin(2 * Math.PI * frequency * t) * 0.6 +
                Math.sin(2 * Math.PI * frequency * 2 * t) * 0.2;
            const value = Math.max(-1, Math.min(1, wave * envelope * 0.35));
            buffer.writeInt16LE(Math.round(value * 32767), offset);
            offset += 2;
        }
    }
    return buffer;
}

function notesFor(kind: SoundName): Array<[number, number]> {
    switch (kind) {
        case 'group':
            // A softer, lower double note so groups do not sound like DMs.
            return [
                [523.25, 90],
                [659.25, 110],
            ];
        case 'mention':
            // Brighter and rising: this one wants attention.
            return [
                [659.25, 80],
                [880, 80],
                [1046.5, 140],
            ];
        default:
            return [
                [659.25, 80],
                [880, 120],
            ];
    }
}

/** Where the chime cache lives, next to the inbox mirror. */
export function soundCacheDir(globalStorage: string): string {
    return path.join(globalStorage, 'sounds');
}

/** True when the OS can actually play a sound on this machine. */
export function canPlaySound(): boolean {
    if (process.platform === 'darwin') return true;
    if (process.platform === 'win32') return true;
    return ['paplay', 'aplay', 'ffplay'].some((command) => which(command));
}

function which(command: string): boolean {
    const paths = (process.env.PATH ?? '').split(path.delimiter);
    return paths.some((dir) => {
        try {
            return fs.existsSync(path.join(dir, command));
        } catch {
            return false;
        }
    });
}
