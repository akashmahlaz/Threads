import * as vscode from 'vscode';
import type { WhatsAppService } from './whatsapp/service';
import { formatPhone } from './whatsapp/store';

/**
 * Copilot tools. This is the point of the extension: the model can see who is
 * talking, what was said in which group, and reply — not just render a sidebar.
 */
export function registerTools(
    context: vscode.ExtensionContext,
    whatsapp: WhatsAppService,
    log: (message: string) => void = () => undefined,
) {
    // One broken registration must not take the other four down with it: VS
    // Code reports the whole extension as failed otherwise.
    const register = <T>(name: string, tool: vscode.LanguageModelTool<T>): void => {
        try {
            context.subscriptions.push(vscode.lm.registerTool<T>(name, tool));
        } catch (err) {
            log(`Could not register ${name}: ${err instanceof Error ? err.message : err}`);
        }
    };

    register<{ to: string; text: string }>('threads_whatsapp_send', {
            invoke: async (options) => {
                const { to, text } = options.input;
                try {
                    await whatsapp.send(to, text);
                    return textResult(`Sent to ${to}.`);
                } catch (err) {
                    return textResult(`Could not send: ${errorMessage(err)}`);
                }
            },
        });

    register<{ limit?: number }>('threads_whatsapp_list_chats', {
            invoke: async (options) => {
                const limit = clamp(options.input.limit, 200);
                const chats = whatsapp.listChats({ includeArchived: true }).slice(0, limit);
                if (!chats.length) return textResult(emptyInbox(whatsapp));

                const lines = chats.map((chat) => {
                    const kind = chat.isGroup ? 'group' : 'direct';
                    const bits = [
                        `${chat.name} [${kind}]`,
                        `id=${chat.id}`,
                        chat.lastTimestamp ? `last=${iso(chat.lastTimestamp)}` : 'no messages yet',
                    ];
                    if (chat.unread) bits.push(`${chat.unread} unread`);
                    if (chat.archived) bits.push('archived');
                    if (chat.muted) bits.push('muted');
                    const who = chat.isGroup && chat.lastSender ? `${chat.lastSender}: ` : '';
                    bits.push(`"${who}${oneLine(chat.lastMessage)}"`);
                    return `- ${bits.join(' · ')}`;
                });
                return textResult(lines.join('\n'));
            },
        });

    register<{ chat_id: string; limit?: number }>('threads_whatsapp_read_chat', {
            invoke: async (options) => {
                const { chat_id } = options.input;
                const chat = whatsapp.listChats({ includeArchived: true }).find((c) => c.id === chat_id);
                const messages = whatsapp.readChat(chat_id, clamp(options.input.limit, 120));
                if (!messages.length) {
                    return textResult(
                        chat
                            ? `No stored messages from ${chat.name}. WhatsApp only sends history when the device is linked, so older messages may be missing.`
                            : `Unknown chat id ${chat_id}. Use threads_whatsapp_list_chats.`,
                    );
                }
                const header = chat
                    ? `${chat.name} (${chat.isGroup ? 'group' : 'direct'}) · ${chat.id}`
                    : chat_id;
                const lines = messages.map((message) => {
                    const who = message.isMe ? 'You' : message.senderName || formatPhone(message.senderId);
                    const quote = message.quoted ? ` (replying to "${oneLine(message.quoted.text)}")` : '';
                    return `[${iso(message.timestamp)}] ${who}: ${message.text}${quote}`;
                });
                return textResult(`${header}\n${lines.join('\n')}`);
            },
        });

    register<{ query: string; limit?: number }>('threads_whatsapp_search', {
            invoke: async (options) => {
                const query = options.input.query?.trim();
                if (!query) return textResult('Missing search query.');
                const hits = whatsapp.search(query, clamp(options.input.limit, 50));
                if (!hits.length) return textResult(`No stored messages match "${query}".`);
                return textResult(
                    hits
                        .map(({ chat, message }) => {
                            const who = message.isMe ? 'You' : message.senderName || 'Them';
                            return `${chat.name} (${chat.id}) · ${iso(message.timestamp)} · ${who}: ${message.text}`;
                        })
                        .join('\n'),
                );
            },
        });

    register<{ limit?: number }>('threads_whatsapp_groups', {
            invoke: async () => {
                const groups = whatsapp.listGroups();
                if (!groups.length) return textResult(emptyInbox(whatsapp));
                const lines = groups.map((group) => {
                    const chat = whatsapp.listChats({ includeArchived: true }).find((c) => c.id === group.id);
                    const bits = [`${group.subject}`, `id=${group.id}`, `${group.members} members`];
                    if (chat?.lastTimestamp) bits.push(`last=${iso(chat.lastTimestamp)}`);
                    return `- ${bits.join(' · ')}`;
                });
                return textResult(lines.join('\n'));
            },
        });

    register('threads_whatsapp_status', {
        invoke: async () => {
            const status = whatsapp.getStatus();
            const state =
                status.state === 'qr'
                    ? 'waiting for a QR scan'
                    : status.state === 'starting'
                      ? 'starting'
                      : status.state;
            return textResult(
                [
                    `WhatsApp: ${state}`,
                    status.account ? `Account: +${status.account}` : 'Account: not linked',
                    `Stored chats: ${status.chatCount}`,
                    `Groups: ${whatsapp.listGroups().length}`,
                    status.syncing ? 'History import: in progress' : 'History import: idle',
                    status.error ? `Last error: ${status.error}` : '',
                ]
                    .filter(Boolean)
                    .join('\n'),
            );
        },
    });
}

function emptyInbox(whatsapp: WhatsAppService): string {
    return whatsapp.isConnected()
        ? 'No WhatsApp conversations stored yet. WhatsApp only sends history when this computer is linked; use the Threads sidebar to re-link and import it.'
        : 'WhatsApp is not connected. Scan the QR code in the Threads sidebar.';
}

function clamp(value: number | undefined, max: number): number {
    if (!value || !Number.isFinite(value)) return Math.min(50, max);
    return Math.min(Math.max(Math.trunc(value), 1), max);
}

function iso(timestamp: number): string {
    return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16);
}

function oneLine(text: string, max = 120): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
