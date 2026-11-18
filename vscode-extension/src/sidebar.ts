import * as vscode from 'vscode';
import type { WhatsAppService, WhatsAppStatus } from './whatsapp/service';
import type { ChatRecord, MessageRecord } from './whatsapp/types';

/**
 * Sidebar webview: the WhatsApp inbox.
 *
 * The webview has no network and no socket access. The extension host pushes
 * the pairing state (QR rendered to a PNG data URL — `qrcode` is Node-only and
 * the webview CSP blocks it), the chat list, the open conversation and search
 * results.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];
    private _openChatId?: string;
    private _inboxTimer?: NodeJS.Timeout;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _service: WhatsAppService,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        this._disposables.push(
            webviewView.webview.onDidReceiveMessage((msg) => this._onMessage(msg)),
            this._service.onDidChange((status) => this._pushState(status)),
            this._service.onInboxChange(() => this._scheduleInbox()),
            webviewView.onDidDispose(() => {
                this._view = undefined;
                this._openChatId = undefined;
            }),
        );
    }

    dispose(): void {
        if (this._inboxTimer) clearTimeout(this._inboxTimer);
        this._disposables.forEach((d) => d.dispose());
        this._disposables = [];
    }

    /** Called by the `threads.openChat` command. */
    openChat(chat: { id: string; name: string }): void {
        void this._open(chat.id, chat.name);
    }

    // ── webview → host ──────────────────────────────────────────────────────

    private async _onMessage(msg: any): Promise<void> {
        try {
            switch (msg?.type) {
                case 'ready':
                case 'refresh':
                    this._pushState(this._service.getStatus());
                    this._pushInbox();
                    break;
                case 'start':
                    await this._service.start();
                    break;
                case 'relink':
                    await this._confirmRelink();
                    break;
                case 'open':
                    await this._open(msg.chatId, msg.name);
                    break;
                case 'close':
                    this._openChatId = undefined;
                    break;
                case 'send':
                    await this._send(msg);
                    break;
                case 'retry':
                    if (msg.chatId && msg.id) await this._service.retry(msg.chatId, msg.id);
                    break;
                case 'new-chat':
                    await this._newChat(msg.to);
                    break;
                case 'search':
                    this._search(String(msg.query ?? ''));
                    break;
            }
        } catch (err) {
            this._error(String(err instanceof Error ? err.message : err));
        }
    }

    private async _confirmRelink(): Promise<void> {
        const choice = await vscode.window.showWarningMessage(
            'Unlink this computer from WhatsApp and link it again? ' +
                'Re-linking is what makes WhatsApp resend your chat, contact and group history.',
            { modal: true },
            'Unlink and link again',
        );
        if (choice === 'Unlink and link again') await this._service.relink();
    }

    private async _open(chatId: string, name?: string): Promise<void> {
        this._openChatId = chatId;
        this._pushMessages();
        await this._service.openChat(chatId);
        if (name) this._pushInbox();
    }

    private async _newChat(to?: string): Promise<void> {
        if (!to?.trim()) return;
        try {
            const chatId = await this._service.newChat(to);
            await this._open(chatId);
        } catch (err) {
            this._sendFailed(undefined, String(err instanceof Error ? err.message : err));
        }
    }

    private async _send(msg: { to?: string; text?: string }): Promise<void> {
        if (!msg.to || !msg.text) return;
        try {
            await this._service.send(msg.to, msg.text);
        } catch (err) {
            this._sendFailed(msg.to, String(err instanceof Error ? err.message : err));
        }
    }

    private _search(query: string): void {
        const trimmed = query.trim();
        if (!trimmed) {
            this._view?.webview.postMessage({ type: 'search', query: '', hits: [] });
            return;
        }
        const hits = this._service.search(trimmed, 40).map(({ chat, message }) => ({
            chatId: chat.id,
            chatName: chat.name,
            isGroup: chat.isGroup,
            text: message.text,
            sender: message.isMe ? 'You' : message.senderName,
            timestamp: message.timestamp,
        }));
        this._view?.webview.postMessage({ type: 'search', query: trimmed, hits });
    }

    // ── host → webview ──────────────────────────────────────────────────────

    private _scheduleInbox(): void {
        if (this._inboxTimer) clearTimeout(this._inboxTimer);
        this._inboxTimer = setTimeout(() => {
            this._inboxTimer = undefined;
            this._pushInbox();
        }, 100);
    }

    private _pushState(status: WhatsAppStatus): void {
        this._view?.webview.postMessage({
            type: 'state',
            state: status.state === 'qr' ? 'pairing' : status.state,
            qrDataUrl: status.qrDataUrl,
            account: status.account,
            error: status.error,
            syncing: status.syncing,
            chatCount: status.chatCount,
        });
    }

    private _pushInbox(): void {
        const view = this._view;
        if (!view) return;

        view.webview.postMessage({
            type: 'chats',
            items: this._service
                .listChats({ includeArchived: true })
                .map((chat) => toWebviewChat(chat, this._service.groupMembers(chat.id))),
        });

        if (this._openChatId) this._pushMessages();
    }

    private _pushMessages(): void {
        if (!this._openChatId) return;
        const chat = this._service
            .listChats({ includeArchived: true })
            .find((c) => c.id === this._openChatId);
        this._view?.webview.postMessage({
            type: 'messages',
            chatId: this._openChatId,
            chat: chat ? toWebviewChat(chat, this._service.groupMembers(chat.id)) : undefined,
            items: this._service.readChat(this._openChatId, 120).map(toWebviewMessage),
        });
    }

    /** A failed send is shown in the conversation, not only in the status bar. */
    private _sendFailed(chatId: string | undefined, message: string): void {
        this._view?.webview.postMessage({ type: 'send-failed', chatId, message });
        this._error(message);
    }

    private _error(message: string): void {
        this._view?.webview.postMessage({ type: 'error', message });
    }

    // ── markup ──────────────────────────────────────────────────────────────

    private _getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'),
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'),
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>Threads</title>
</head>
<body>
    <div id="app">
        <section id="banner" class="banner hidden">
            <p id="banner-title" class="banner-title"></p>
            <p id="banner-text" class="banner-text"></p>
            <img id="qr-image" class="qr hidden" alt="WhatsApp pairing QR code" />
            <p id="banner-hint" class="hint"></p>
            <div class="banner-actions">
                <button id="banner-primary" class="btn primary hidden"></button>
                <button id="banner-secondary" class="btn ghost hidden"></button>
            </div>
        </section>

        <section id="list-pane" class="list-pane">
            <header class="list-header">
                <span class="list-title">WhatsApp</span>
                <button id="new-chat-btn" class="icon-btn" title="New chat" aria-label="New chat">+</button>
            </header>
            <form id="new-chat-form" class="new-chat hidden">
                <input id="new-chat-input" type="tel" placeholder="Phone number with country code" autocomplete="off" />
                <button class="btn primary" type="submit">Start</button>
            </form>
            <div class="search-row">
                <input id="search" type="search" placeholder="Search chats and messages" autocomplete="off" />
            </div>
            <div id="search-hits" class="search-hits hidden" role="list"></div>
            <div id="chat-list" class="chat-list" role="list"></div>
            <button id="archived-toggle" class="archived-toggle hidden"></button>
            <div id="chat-list-empty" class="empty hidden"></div>
        </section>

        <section id="chat-view" class="chat-view hidden">
            <header class="chat-header">
                <button id="back-btn" class="icon-btn" title="Back" aria-label="Back">&#8592;</button>
                <span id="chat-avatar" class="avatar" aria-hidden="true"></span>
                <span class="chat-headings">
                    <span id="chat-title" class="chat-title"></span>
                    <span id="chat-subtitle" class="chat-subtitle"></span>
                </span>
            </header>
            <div id="messages" class="messages" role="log"></div>
            <div class="composer">
                <textarea id="msg-input" rows="1" placeholder="Message" aria-label="Message"></textarea>
                <button id="send-btn" class="btn primary" title="Send">Send</button>
            </div>
        </section>

        <footer id="status-bar" class="status-bar"></footer>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function toWebviewChat(chat: ChatRecord, members: number) {
    return {
        id: chat.id,
        name: chat.name,
        isGroup: chat.isGroup,
        members,
        preview: chat.lastMessage,
        sender: chat.lastSender,
        timestamp: chat.lastTimestamp,
        unread: chat.unread,
        muted: chat.muted,
        archived: chat.archived,
    };
}

function toWebviewMessage(message: MessageRecord) {
    return {
        id: message.id,
        text: message.text,
        kind: message.kind,
        mine: message.isMe,
        sender: message.isMe ? '' : message.senderName,
        timestamp: message.timestamp,
        quoted: message.quoted,
        media: message.media,
        status: message.status,
        edited: message.edited,
        deleted: message.deleted,
    };
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
