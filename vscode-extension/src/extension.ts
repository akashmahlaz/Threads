import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SidebarProvider } from './sidebar';
import { registerTools } from './tools';
import { WhatsAppStore } from './whatsapp/store';
import { WhatsAppService } from './whatsapp/service';

let whatsapp: WhatsAppService | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const storage = context.globalStorageUri.fsPath;
    const store = new WhatsAppStore(path.join(storage, 'inbox.json'));
    store.load();

    const service = new WhatsAppService(
        vscode.Uri.joinPath(context.globalStorageUri, 'whatsapp-auth').fsPath,
        store,
        (line) => log(line),
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
    );

    registerTools(context, service);

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

    // Pairing starts on activation so the tools work before the sidebar opens.
    void service.start();
    log(`Threads activated (store ${storage})`);
}

export function deactivate() {
    whatsapp?.dispose();
    whatsapp = undefined;
}

/** Extension-host log, kept where VS Code users can find it. */
export function logPath(): string {
    return path.join(os.homedir(), 'Library', 'Logs', 'threads', 'threads.log');
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
