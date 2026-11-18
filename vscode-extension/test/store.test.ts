import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WhatsAppStore } from '../src/whatsapp/store';

/** A store backed by a throwaway file, so tests never touch real data. */
function fresh(name: string): WhatsAppStore {
    return new WhatsAppStore(`/tmp/threads-test-${name}-${process.pid}.json`);
}

function message(overrides: Record<string, unknown> = {}) {
    return {
        id: `m-${Math.random().toString(36).slice(2)}`,
        chatId: '15551234567@s.whatsapp.net',
        text: 'hello',
        kind: 'text' as const,
        senderId: '15551234567@s.whatsapp.net',
        senderName: 'Ada',
        isMe: false,
        timestamp: Date.now(),
        ...overrides,
    };
}

test('a chat keeps the name it was given', () => {
    const store = fresh('name');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada Lovelace' });
    const chat = store.listChats({ includeArchived: true })[0];
    assert.equal(chat.name, 'Ada Lovelace');
});

test('a raw LID number is never kept as a chat name', () => {
    const store = fresh('lidname');
    store.upsertChat({ id: '254034497798362@lid', name: '+254034497798362' });
    const chat = store.listChats({ includeArchived: true })[0];
    assert.ok(
        !chat.name.includes('254034497798362'),
        `name should not echo the raw LID, was ${chat.name}`,
    );
});

test('a LID chat is rekeyed onto its phone-number JID once the alias is known', () => {
    const store = fresh('rekey');
    store.setAliases([{ lid: '254034497798362@lid', pn: '917889033435@s.whatsapp.net' }]);
    store.upsertChat({ id: '254034497798362@lid', name: 'Sachin' });
    store.applyMessage(message({ chatId: '254034497798362@lid' }));

    const chats = store.listChats({ includeArchived: true });
    assert.equal(chats.length, 1);
    assert.equal(chats[0].id, '917889033435@s.whatsapp.net');
    assert.equal(chats[0].name, 'Sachin');
});

test('aliases learned from disk resolve a LID to a phone number', () => {
    const store = fresh('disk');
    const fs = require('node:fs') as typeof import('node:fs');
    const dir = `/tmp/threads-test-lidmap-${process.pid}`;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/lid-mapping-254034497798362_reverse.json`, '"917889033435"');
    fs.writeFileSync(`${dir}/lid-mapping-917889033435.json`, '"254034497798362"');

    const learned = store.learnAliasesFromDisk(dir);
    assert.ok(learned >= 1, `learned ${learned}`);
    assert.equal(store.canonicalJid('254034497798362@lid'), '917889033435@s.whatsapp.net');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('search finds messages regardless of case', () => {
    const store = fresh('search');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    store.applyMessage(message({ id: 'a', text: 'Hello World' }));
    store.applyMessage(message({ id: 'b', text: 'Goodbye' }));

    assert.equal(store.search('hello').length, 1);
    assert.equal(store.search('WORLD').length, 1);
    assert.equal(store.search('nothing here').length, 0);
});

test('editing a message updates what search finds', () => {
    const store = fresh('edit');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    store.applyMessage(message({ id: 'a', text: 'Hello' }));

    assert.equal(store.search('goodbye').length, 0);
    store.updateMessage('15551234567@s.whatsapp.net', 'a', { text: 'Goodbye' });
    assert.equal(store.search('goodbye').length, 1);
    assert.equal(store.search('hello').length, 0);
});

test('a deleted message stops matching searches', () => {
    const store = fresh('delete');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    store.applyMessage(message({ id: 'a', text: 'Secret' }));
    assert.equal(store.search('secret').length, 1);

    store.removeMessage('15551234567@s.whatsapp.net', 'a');
    assert.equal(store.search('secret').length, 0);
});

test('reactions are kept per sender and a removal clears them', () => {
    const store = fresh('react');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    store.applyMessage(message({ id: 'a', text: 'hi' }));

    store.setReaction('15551234567@s.whatsapp.net', 'a', {
        text: '👍',
        senderId: '15551234567@s.whatsapp.net',
        senderName: 'Ada',
    });
    let stored = store.listMessages('15551234567@s.whatsapp.net').find((m) => m.id === 'a');
    assert.equal(stored?.reactions?.length, 1);
    assert.equal(stored?.reactions?.[0].text, '👍');

    store.setReaction('15551234567@s.whatsapp.net', 'a', {
        text: '❤️',
        senderId: '15551234567@s.whatsapp.net',
        senderName: 'Ada',
    });
    stored = store.listMessages('15551234567@s.whatsapp.net').find((m) => m.id === 'a');
    assert.equal(stored?.reactions?.length, 1);
    assert.equal(stored?.reactions?.[0].text, '❤️');

    store.setReaction('15551234567@s.whatsapp.net', 'a', {
        text: '',
        senderId: '15551234567@s.whatsapp.net',
        senderName: 'Ada',
    });
    stored = store.listMessages('15551234567@s.whatsapp.net').find((m) => m.id === 'a');
    assert.equal(stored?.reactions?.length, 0);
});

test('unread counts rise on incoming messages and clear on read', () => {
    const store = fresh('unread');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    store.applyMessage(message({ id: 'a' }));
    store.applyMessage(message({ id: 'b' }));
    assert.equal(store.getChat('15551234567@s.whatsapp.net')?.unread, 2);

    store.clearUnread('15551234567@s.whatsapp.net');
    assert.equal(store.getChat('15551234567@s.whatsapp.net')?.unread, 0);
});

test('messages you send do not add to the unread count', () => {
    const store = fresh('self');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    store.applyMessage(message({ id: 'a', isMe: true, senderName: 'You' }));
    assert.equal(store.getChat('15551234567@s.whatsapp.net')?.unread, 0);
});

test('pinned chats sort above unpinned ones', () => {
    const store = fresh('pin');
    store.upsertChat({ id: '1@s.whatsapp.net', name: 'Old', lastTimestamp: 1_000 });
    store.upsertChat({ id: '2@s.whatsapp.net', name: 'New', lastTimestamp: 9_000 });
    store.setPinned('1@s.whatsapp.net', true);

    const chats = store.listChats();
    assert.equal(chats[0].name, 'Old');
});

test('a mute survives a reload of the store', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const file = `/tmp/threads-test-persist-${process.pid}.json`;
    fs.rmSync(file, { force: true });

    const first = new WhatsAppStore(file);
    first.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    first.setMuted('15551234567@s.whatsapp.net', true);
    first.save();

    const second = new WhatsAppStore(file);
    second.load();
    assert.equal(second.getChat('15551234567@s.whatsapp.net')?.muted, true);
    fs.rmSync(file, { force: true });
});

test('presence updates are stored on the chat', () => {
    const store = fresh('presence');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    store.setChatPresence('15551234567@s.whatsapp.net', { online: true });
    assert.equal(store.getChat('15551234567@s.whatsapp.net')?.online, true);

    store.setChatPresence('15551234567@s.whatsapp.net', {
        online: false,
        lastSeen: 1_700_000_000_000,
    });
    const chat = store.getChat('15551234567@s.whatsapp.net');
    assert.equal(chat?.online, false);
    assert.equal(chat?.lastSeen, 1_700_000_000_000);
});

test('a chat with no messages reports no history', () => {
    const store = fresh('empty');
    store.upsertChat({ id: '15551234567@s.whatsapp.net', name: 'Ada' });
    assert.equal(store.listMessages('15551234567@s.whatsapp.net').length, 0);
});

test('device suffixes are stripped when matching a JID', () => {
    const store = fresh('device');
    store.setAliases([{ lid: '254034497798362@lid', pn: '917889033435:12@s.whatsapp.net' }]);
    assert.equal(store.canonicalJid('254034497798362@lid'), '917889033435@s.whatsapp.net');
});