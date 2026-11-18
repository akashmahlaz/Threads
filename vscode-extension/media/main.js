// Threads sidebar — webview script.
// Pure view: it renders whatever the extension host pushes and posts user
// actions back. No network, no socket, no direct WhatsApp access.
(function () {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const post = (msg) => vscode.postMessage(msg);

    let chats = [];
    let hits = [];
    let openChat = null;
    let conn = { state: 'starting', chatCount: 0, syncing: false };
    let filter = '';
    let archivedOpen = false;
    let errorTimer;
    let searchTimer;

    // ── host messages ───────────────────────────────────────────────────────
    window.addEventListener('message', (event) => {
        const msg = event.data || {};
        switch (msg.type) {
            case 'state':
                conn = msg;
                renderState(msg);
                break;
            case 'chats':
                chats = msg.items || [];
                renderChats();
                break;
            case 'messages':
                if (openChat && msg.chatId === openChat.id) {
                    if (msg.chat) {
                        openChat = { ...openChat, ...msg.chat };
                        renderChatHeader(openChat, msg.typing);
                    } else {
                        renderChatHeader(openChat, msg.typing);
                    }
                    renderMessages(msg.items || []);
                }
                break;
            case 'search':
                hits = msg.hits || [];
                renderHits(msg.query);
                break;
            case 'send-failed':
                showError(msg.message || 'Message not sent');
                break;
            case 'error':
                showError(msg.message);
                break;
        }
    });

    // ── connection state ────────────────────────────────────────────────────
    function renderState(s) {
        document.body.dataset.state = s.state;
        setStatus(statusLine(s));

        const banner = $('banner');
        const qr = $('qr-image');
        const primary = $('banner-primary');
        const secondary = $('banner-secondary');

        let title = '';
        let text = '';
        let hint = '';
        let showQr = false;
        let primaryLabel = '';
        let secondaryLabel = '';

        if (s.state === 'pairing') {
            title = 'Link this computer';
            text = 'Scan the code with WhatsApp. The code refreshes on its own.';
            hint = 'WhatsApp → Settings → Linked devices → Link a device';
            showQr = Boolean(s.qrDataUrl);
            secondaryLabel = 'Start over';
        } else if (s.state === 'starting') {
            title = 'Connecting…';
            text = 'Opening the WhatsApp link.';
        } else if (s.state === 'error') {
            title = 'WhatsApp needs attention';
            text = s.error || 'Something went wrong.';
            primaryLabel = 'Reconnect';
            secondaryLabel = 'Link again';
        } else if (s.state === 'disconnected') {
            title = 'Reconnecting…';
            text = 'The WhatsApp link dropped. Retrying automatically.';
            primaryLabel = 'Reconnect now';
        } else if (s.state === 'connected' && !s.chatCount) {
            title = 'No conversations yet';
            text =
                'If you just linked this computer, WhatsApp may not have sent your history. ' +
                'Linking again imports chats, contacts and groups.';
            secondaryLabel = 'Import history';
        }

        const visible = Boolean(title);
        banner.classList.toggle('hidden', !visible);
        if (!visible) return;

        $('banner-title').textContent = title;
        $('banner-text').textContent = text;
        $('banner-hint').textContent = hint;
        $('banner-hint').classList.toggle('hidden', !hint);

        if (showQr) {
            qr.src = s.qrDataUrl;
            qr.classList.remove('hidden');
        } else {
            qr.removeAttribute('src');
            qr.classList.add('hidden');
        }

        primary.textContent = primaryLabel;
        primary.classList.toggle('hidden', !primaryLabel);
        secondary.textContent = secondaryLabel;
        secondary.classList.toggle('hidden', !secondaryLabel);
    }

    function statusLine(s) {
        if (s.state === 'connected') {
            const who = s.account ? `+${s.account}` : 'WhatsApp';
            const count = s.chatCount === 1 ? '1 chat' : `${s.chatCount} chats`;
            return s.syncing ? `${who} · importing history…` : `${who} · ${count}`;
        }
        if (s.state === 'pairing') return 'Waiting for scan';
        if (s.state === 'starting') return 'Connecting…';
        if (s.state === 'error') return 'Not connected';
        return 'Reconnecting…';
    }

    function setStatus(text) {
        const bar = $('status-bar');
        bar.textContent = text;
        bar.classList.remove('error');
    }

    function showError(message) {
        const bar = $('status-bar');
        bar.textContent = message;
        bar.classList.add('error');
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => setStatus(statusLine(conn)), 6000);
    }

    // ── chat list ───────────────────────────────────────────────────────────
    function renderChats() {
        const list = $('chat-list');
        const empty = $('chat-list-empty');
        const toggle = $('archived-toggle');
        list.textContent = '';

        const needle = filter.trim().toLowerCase();
        const archivedCount = chats.filter((chat) => chat.archived).length;

        toggle.textContent = archivedOpen
            ? 'Back to inbox'
            : `Archived (${archivedCount})`;
        toggle.classList.toggle('hidden', archivedCount === 0 && !archivedOpen);

        const pool = chats.filter((chat) => Boolean(chat.archived) === archivedOpen);
        const visible = needle
            ? pool.filter(
                  (chat) =>
                      chat.name.toLowerCase().includes(needle) ||
                      (chat.preview || '').toLowerCase().includes(needle),
              )
            : pool;

        if (!visible.length) {
            empty.textContent = needle
                ? `No chats match “${filter.trim()}”`
                : archivedOpen
                  ? 'No archived chats.'
                  : conn.state === 'connected'
                    ? 'Conversations appear here as WhatsApp syncs them.'
                    : '';
            empty.classList.toggle('hidden', !empty.textContent);
            return;
        }
        empty.classList.add('hidden');

        for (const chat of visible) {
            list.appendChild(chatRow(chat));
        }
    }

    function chatRow(chat) {
        const row = document.createElement('div');
        row.className = 'chat-row';
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;

        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        avatar.style.setProperty('--hue', hueOf(chat.id));
        avatar.textContent = initials(chat.name);
        if (chat.isGroup) avatar.classList.add('group');

        const main = document.createElement('span');
        main.className = 'chat-main';

        const top = document.createElement('span');
        top.className = 'chat-top';
        const name = document.createElement('span');
        name.className = 'chat-name';
        name.textContent = chat.name;
        const time = document.createElement('span');
        time.className = 'chat-time';
        time.textContent = chat.timestamp ? shortTime(chat.timestamp) : '';
        top.append(name, time);

        const bottom = document.createElement('span');
        bottom.className = 'chat-bottom';
        const preview = document.createElement('span');
        preview.className = 'chat-preview';
        const prefix = chat.isGroup && chat.sender ? `${chat.sender}: ` : '';
        preview.textContent = `${prefix}${chat.preview || ''}`;
        bottom.appendChild(preview);

        if (chat.muted) {
            const muted = document.createElement('span');
            muted.className = 'muted-mark';
            muted.title = 'Muted';
            muted.textContent = 'muted';
            bottom.appendChild(muted);
        }
        if (chat.unread > 0) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = chat.unread > 99 ? '99+' : String(chat.unread);
            bottom.appendChild(badge);
        }

        main.append(top, bottom);
        row.append(avatar, main);
        row.addEventListener('click', () => showChat(chat));
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showChat(chat);
            }
        });
        return row;
    }

    // ── message search ──────────────────────────────────────────────────────
    function renderHits(query) {
        const box = $('search-hits');
        box.textContent = '';
        const visible = Boolean(query && query.trim()) && hits.length > 0;
        box.classList.toggle('hidden', !visible);
        if (!visible) return;

        const label = document.createElement('div');
        label.className = 'hits-label';
        label.textContent = `${hits.length} matching message${hits.length === 1 ? '' : 's'}`;
        box.appendChild(label);

        for (const hit of hits) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'hit';

            const meta = document.createElement('span');
            meta.className = 'hit-meta';
            meta.textContent = `${hit.chatName} · ${shortTime(hit.timestamp)}`;

            const text = document.createElement('span');
            text.className = 'hit-text';
            text.textContent = `${hit.sender ? `${hit.sender}: ` : ''}${hit.text}`;

            row.append(meta, text);
            row.addEventListener('click', () =>
                showChat({ id: hit.chatId, name: hit.chatName, isGroup: hit.isGroup }),
            );
            box.appendChild(row);
        }
    }

    // ── conversation ────────────────────────────────────────────────────────
    function showChat(chat) {
        openChat = chat;
        $('list-pane').classList.add('hidden');
        $('chat-view').classList.remove('hidden');
        renderChatHeader(chat);
        $('messages').textContent = '';
        post({ type: 'open', chatId: chat.id, name: chat.name });
        $('msg-input').focus();
    }

    function renderChatHeader(chat, typing) {
        $('chat-title').textContent = chat.name;
        const base = chat.isGroup
            ? chat.members
                ? `${chat.members} members`
                : 'Group'
            : chat.id.endsWith('@lid')
              ? 'WhatsApp contact'
              : formatPhone(chat.id);
        const subtitle = $('chat-subtitle');
        subtitle.textContent = typing ? 'typing…' : base;
        subtitle.classList.toggle('typing', Boolean(typing));
        $('chat-avatar').style.setProperty('--hue', hueOf(chat.id));
        $('chat-avatar').textContent = initials(chat.name);
        $('chat-avatar').classList.toggle('group', Boolean(chat.isGroup));
    }

    function renderMessages(items) {
        const box = $('messages');
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
        box.textContent = '';

        let lastDay = '';
        for (const message of items) {
            const day = dayLabel(message.timestamp);
            if (day !== lastDay) {
                lastDay = day;
                const divider = document.createElement('div');
                divider.className = 'day';
                divider.textContent = day;
                box.appendChild(divider);
            }
            box.appendChild(messageNode(message));
        }

        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No stored messages in this chat yet.';
            box.appendChild(empty);
        }
        if (atBottom) box.scrollTop = box.scrollHeight;
    }

    function messageNode(message) {
        if (message.kind === 'system' || message.deleted) {
            const sys = document.createElement('div');
            sys.className = 'system';
            sys.textContent = message.deleted ? 'This message was deleted' : message.text;
            return sys;
        }

        const row = document.createElement('div');
        row.className = message.mine ? 'row mine' : 'row theirs';
        if (message.status === 'failed') row.classList.add('failed');

        const bubble = document.createElement('div');
        bubble.className = `bubble ${message.kind}`;

        if (!message.mine && message.sender) {
            const who = document.createElement('span');
            who.className = 'sender';
            who.style.setProperty('--hue', hueOf(message.sender));
            who.textContent = message.sender;
            bubble.appendChild(who);
        }

        if (message.quoted) {
            const quote = document.createElement('div');
            quote.className = 'quote';
            if (message.quoted.senderName) {
                const quoteSender = document.createElement('span');
                quoteSender.className = 'quote-sender';
                quoteSender.textContent = message.quoted.senderName;
                quote.appendChild(quoteSender);
            }
            const quoteText = document.createElement('span');
            quoteText.className = 'quote-text';
            quoteText.textContent = message.quoted.text;
            quote.appendChild(quoteText);
            bubble.appendChild(quote);
        }

        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = message.text;
        bubble.appendChild(text);

        const meta = document.createElement('span');
        meta.className = 'meta';

        if (message.edited) {
            const edited = document.createElement('span');
            edited.className = 'edited';
            edited.textContent = 'edited';
            meta.appendChild(edited);
        }

        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = clockTime(message.timestamp);
        meta.appendChild(time);

        if (message.mine) meta.appendChild(tick(message.status));

        bubble.appendChild(meta);

        if (message.status === 'failed') {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'retry';
            retry.textContent = 'Not sent · Retry';
            retry.addEventListener('click', () =>
                post({ type: 'retry', chatId: openChat.id, id: message.id }),
            );
            bubble.appendChild(retry);
        }

        row.appendChild(bubble);
        return row;
    }

    function tick(status) {
        const span = document.createElement('span');
        span.className = 'tick';
        if (status === 'failed') {
            span.classList.add('failed');
            span.textContent = '!';
            span.title = 'Not sent';
            return span;
        }
        if (status === 'read') {
            span.classList.add('read');
            span.textContent = '✓✓';
            span.title = 'Read';
            return span;
        }
        if (status === 'delivered') {
            span.textContent = '✓✓';
            span.title = 'Delivered';
            return span;
        }
        if (status === 'pending') {
            span.classList.add('pending');
            span.textContent = '✓';
            span.title = 'Sending';
            return span;
        }
        span.textContent = '✓';
        span.title = 'Sent';
        return span;
    }

    // ── composer ────────────────────────────────────────────────────────────
    const input = $('msg-input');

    function sendMessage() {
        const text = input.value.trim();
        if (!text || !openChat) return;
        post({ type: 'send', to: openChat.id, text });
        input.value = '';
        autoGrow();
        input.focus();
    }

    function autoGrow() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    }

    $('send-btn').addEventListener('click', sendMessage);
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    $('back-btn').addEventListener('click', () => {
        openChat = null;
        $('chat-view').classList.add('hidden');
        $('list-pane').classList.remove('hidden');
        post({ type: 'close' });
    });

    // ── search box ──────────────────────────────────────────────────────────
    $('search').addEventListener('input', (event) => {
        filter = event.target.value || '';
        renderChats();

        clearTimeout(searchTimer);
        const query = filter.trim();
        if (!query) {
            hits = [];
            renderHits('');
            return;
        }
        searchTimer = setTimeout(() => post({ type: 'search', query }), 200);
    });

    // ── new chat ────────────────────────────────────────────────────────────
    $('new-chat-btn').addEventListener('click', () => {
        const form = $('new-chat-form');
        form.classList.toggle('hidden');
        if (!form.classList.contains('hidden')) $('new-chat-input').focus();
    });

    $('new-chat-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const value = $('new-chat-input').value.trim();
        if (!value) return;
        post({ type: 'new-chat', to: value });
        $('new-chat-input').value = '';
        $('new-chat-form').classList.add('hidden');
    });

    // ── archived ────────────────────────────────────────────────────────────
    $('archived-toggle').addEventListener('click', () => {
        archivedOpen = !archivedOpen;
        renderChats();
        $('chat-list').scrollTop = 0;
    });

    $('banner-primary').addEventListener('click', () => post({ type: 'start' }));
    $('banner-secondary').addEventListener('click', () => post({ type: 'relink' }));

    // ── formatting helpers ──────────────────────────────────────────────────
    function initials(name) {
        const digits = String(name || '').replace(/\D/g, '');
        if (digits && /^[+\d\s()\-]+$/.test(String(name))) return digits.slice(-2);
        const words = String(name || '?')
            .split(/[\s_\-.]+/)
            .filter(Boolean);
        if (!words.length) return '?';
        return words
            .slice(0, 2)
            .map((word) => word[0])
            .join('')
            .toUpperCase();
    }

    function hueOf(seed) {
        let hash = 0;
        for (let i = 0; i < String(seed).length; i++) {
            hash = (hash * 31 + String(seed).charCodeAt(i)) % 360;
        }
        return String(hash);
    }

    function formatPhone(jid) {
        const digits = String(jid).split('@')[0].replace(/\D/g, '');
        return digits ? `+${digits}` : jid;
    }

    function clockTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function shortTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const sameDay = date.toDateString() === now.toDateString();
        if (sameDay) return clockTime(timestamp);
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
    }

    function dayLabel(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        if (date.toDateString() === now.toDateString()) return 'Today';
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return date.toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'long',
            year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
        });
    }

    // ── boot ────────────────────────────────────────────────────────────────
    post({ type: 'ready' });
})();
