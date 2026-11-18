import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SidebarProvider } from './sidebar';
import { registerTools } from './tools';
import { WhatsAppStore } from './whatsapp/store';
import { WhatsAppService } from './whatsapp/service';
import { canPlaySound } from './whatsapp/sound';
import type { ChatRecord, MessageRecord } from './whatsapp/types';

let whatsapp: WhatsAppService | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const storage = context.globalStorageUri.fsPath;
    const store = new WhatsAppStore(path.join(storage, 'inbox.json'));
    store.load();

    const service = new WhatsAppService(
        vscode.Uri.joinPath(context.globalStorageUri, 'whatsapp-auth').fsPath,
        store,
        (line) => log(line),
        path.join(storage, 'media'),
        path.join(storage, 'sounds'),
    );
    whatsapp = service;
    context.subscriptions.push({ dispose: () => store.dispose() }, { dispose: () => service.dispose() });

    const sidebarProvider = new SidebarProvider(context.extensionUri, service);

    context.subscriptions.push(
        sidebarProvider,
        vscode.window.registerWebviewViewProvider('threads.sidebar', sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),

        vscode.commands.registerCommand('threads.startWhatsApp', async () => {
            await withProgress('Connecting to WhatsApp…', () => service.start());
        }),
        vscode.commands.registerCommand('threads.stopWhatsApp', async () => {
            await service.stop();
        }),
        vscode.commands.registerCommand('threads.logoutWhatsApp', async () => {
            const choice = await vscode.window.showWarningMessage(
                'Unlink this computer from WhatsApp and link it again? ' +
                    'Re-linking is what makes WhatsApp resend your chat, contact and group history.',
                { modal: true },
                'Unlink and link again',
            );
            if (choice !== 'Unlink and link again') return;
            await withProgress('Re-linking WhatsApp…', () => service.relink());
        }),
        vscode.commands.registerCommand('threads.checkCopilot', async () => {
            const tools = vscode.lm.tools.filter((tool) =>
                tool.name.startsWith('threads_whatsapp_'),
            );
            if (!tools.length) {
                void vscode.window.showWarningMessage(
                    'Copilot cannot see the Threads tools in this window. ' +
                        'Reload the window and make sure the Threads extension is enabled.',
                );
                return;
            }
            void vscode.window.showInformationMessage(
                `Copilot can use ${tools.length} Threads tools: ${tools
                    .map((tool) => tool.name)
                    .join(', ')}. WhatsApp is ${
                    service.isConnected() ? 'connected' : 'not connected'
                }. If Copilot still says they are unavailable, open the tools picker in chat and enable them in Agent mode.`,
            );
        }),
        vscode.commands.registerCommand('threads.openLogs', async () => {
            const file = logPath();
            try {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
            } catch {
                vscode.window.showInformationMessage(`Threads log: ${file}`);
            }
        }),
        vscode.commands.registerCommand('threads.openChat', async (chat) => {
            if (!chat?.id) return;
            sidebarProvider.openChat({ id: chat.id, name: chat.name ?? chat.id });
            await vscode.commands.executeCommand('threads.sidebar.focus');
        }),
        vscode.commands.registerCommand('threads.testSound', async () => {
            if (!canPlaySound()) {
                void vscode.window.showWarningMessage(
                    'No audio player was found on this machine, so Threads cannot play a chime. ' +
                        'On Linux, install one of `paplay`, `aplay` or `ffplay`.',
                );
                return;
            }
            service.playSound('message');
            void vscode.window.showInformationMessage('Playing the Threads chime.');
        }),
    );

    registerTools(context, service, log);

    // A linked device only receives history at link time. If this computer is
    // connected but the inbox is empty, offer the one thing that fixes it.
    let prompted = context.globalState.get<boolean>('relinkPrompted', false);
    context.subscriptions.push(
        service.onDidChange((status) => {
            if (prompted || status.state !== 'connected' || status.chatCount > 0) return;
            prompted = true;
            void context.globalState.update('relinkPrompted', true);
            void vscode.window
                .showInformationMessage(
                    'WhatsApp is linked, but this computer has no chat history. ' +
                        'Re-linking imports your chats, contacts and groups.',
                    'Re-link and import',
                    'Later',
                )
                .then(async (choice) => {
                    if (choice === 'Re-link and import') await service.relink();
                });
        }),
    );

    // ── unread badge ────────────────────────────────────────────────────────
    // VS Code has no API for a badge on an activity-bar view container, so the
    // status bar plus a count in the view title is as close as it gets.
    const badge = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    badge.command = 'threads.sidebar.focus';
    badge.name = 'Threads WhatsApp';
    context.subscriptions.push(badge);

    const refreshBadge = () => {
        const unread = service
            .listChats({ includeArchived: false })
            .reduce((total, chat) => total + chat.unread, 0);
        if (!service.isConnected() || unread <= 0) {
            badge.hide();
            return;
        }
        badge.text = `$(comment-discussion) WhatsApp ${unread}`;
        badge.tooltip = `${unread} unread WhatsApp message${unread === 1 ? '' : 's'}`;
        badge.show();
    };
    context.subscriptions.push(service.onInboxChange(refreshBadge), service.onDidChange(refreshBadge));

    // ── incoming message alerts ─────────────────────────────────────────────
    // Sound and notifications are opt-in, and both respect a muted chat.
    context.subscriptions.push(
        service.onIncoming((message, chat) => {
            void alert(context, service, message, chat);
        }),
    );

    // The link is opened by the sidebar or by the first tool call, so several
    // VS Code windows cannot fight over one WhatsApp session.
    log(`Threads activated (store ${storage})`);
}

export function deactivate() {
    whatsapp?.dispose();
    whatsapp = undefined;
}

/**
 * Play a chime and/or show a notification for one incoming message.
 *
 * Both are settings, both default to on, and a muted chat silences both. The
 * notification is skipped while the chat is open, because the user is already
 * looking at it.
 */
async function alert(
    context: vscode.ExtensionContext,
    service: WhatsAppService,
    message: MessageRecord,
    chat: ChatRecord,
): Promise<void> {
    const config = vscode.workspace.getConfiguration('threads');
    const soundOn = config.get<boolean>('notifications.sound', true);
    const alertsOn = config.get<boolean>('notifications.enabled', true);
    const previewOn = config.get<boolean>('notifications.showPreview', true);

    // A muted chat is silent, and so is a chat you are looking at.
    if (!chat.muted && soundOn) {
        service.playSound(soundFor(chat, message), chat.id);
    }
    if (!alertsOn || chat.muted) return;
    if (service.currentChatId() === chat.id) return;

    const body = previewOn ? `: ${preview(message)}` : '';
    const choice = await vscode.window.showInformationMessage(
        `${chat.name}${body}`,
        'Open',
        'Mute',
    );
    if (choice === 'Open') {
        await vscode.commands.executeCommand('threads.openChat', chat);
    } else if (choice === 'Mute') {
        service.setMuted(chat.id, true);
    }
}

function soundFor(chat: ChatRecord, message: MessageRecord): 'message' | 'group' | 'mention' {
    if (chat.isGroup) {
        const mention = message.text.includes('@');
        return mention ? 'mention' : 'group';
    }
    return 'message';
}

function preview(message: MessageRecord): string {
    const text = message.text.replace(/\s+/g, ' ').trim();
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** Extension-host log, kept where VS Code users can find it. */
export function logPath(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Logs', 'threads', 'threads.log');
    }
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA ?? os.homedir(), 'threads', 'logs', 'threads.log');
    }
    const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
    return path.join(stateHome, 'threads', 'logs', 'threads.log');
}

let logStream: fs.WriteStream | undefined;

function log(line: string): void {
    const entry = `[${new Date().toISOString()}] ${line}`;
    console.log(`[threads] ${line}`);
    try {
        if (!logStream) {
            const file = logPath();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            logStream = fs.createWriteStream(file, { flags: 'a' });
        }
        logStream?.write(`${entry}\n`);
    } catch {
        // Logging must never break messaging.
    }
}

async function withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        task,
    );
}