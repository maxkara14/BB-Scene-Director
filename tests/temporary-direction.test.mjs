import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryDirectionController, normalizeTemporaryDirection } from '../temporary-direction.js';
import { createFixture } from './helpers.mjs';

function setup() {
    const f = createFixture();
    const context = { chatId: 'A', characterId: 0, chat: [] };
    let saves = 0;
    const controller = createTemporaryDirectionController({
        getSettings: () => f.settings, getContext: () => context,
        isCurrentChat: () => context.chatId === 'A', save: () => saves++, changed() {},
    });
    const send = () => {
        context.chat.push({ is_user: true, mes: 'User', send_date: String(saves) });
        return controller.userSent(context.chat.length - 1);
    };
    return { ...f, context, controller, send, saves: () => saves };
}

test('one turn starts with first user message and expires before the second reply', () => {
    const f = setup();
    f.controller.arm('Knock', 1);
    f.send();
    assert.equal(f.controller.getText(), 'Knock');
    assert.equal(f.settings.temporaryDirection.remaining, 1);
    f.context.chat.push({ mes: 'Reply' });
    assert.equal(f.controller.getText(), 'Knock');
    f.send();
    assert.equal(f.controller.getText(), '');
    assert.equal(f.settings.temporaryDirection.remaining, 0);
});

test('an existing unanswered user message already starts the first turn', () => {
    const f = setup();
    f.send();
    f.controller.arm('Knock', 1);
    assert.equal(f.settings.temporaryDirection.turnStarted, true);
    assert.equal(f.controller.userSent(0), false);
    f.context.chat.push({ mes: 'Reply' });
    f.send();
    assert.equal(f.controller.getText(), '');
});

test('arming after a character reply waits for the next user message to begin', () => {
    const f = setup();
    f.context.chat.push({ is_user: true, mes: 'User' }, { mes: 'Reply' });
    f.controller.arm('Knock', 1);
    assert.equal(f.settings.temporaryDirection.turnStarted, false);
    f.send();
    assert.equal(f.settings.temporaryDirection.remaining, 1);
    f.send();
    assert.equal(f.settings.temporaryDirection.remaining, 0);
});

test('rerolls and continuation start an existing turn and never spend its budget', () => {
    for (const type of ['regenerate', 'swipe', 'continue', 'normal']) {
        const f = setup();
        f.context.chat.push({ is_user: true, send_date: 'one' }, { mes: 'Interrupted reply' });
        f.controller.arm('Knock', 1);
        for (let i = 0; i < 3; i++) {
            f.controller.preparingReply(type);
            f.controller.replyPrepared();
            assert.equal(f.settings.temporaryDirection.turnStarted, true);
            assert.equal(f.settings.temporaryDirection.remaining, 1);
        }
        f.send();
        assert.equal(f.controller.getText(), '');
    }
});

test('preview, quiet, impersonation, abort and changed scope do not start a turn', () => {
    for (const variant of ['preview', 'quiet', 'impersonate', 'abort', 'chat', 'rearm', 'pause']) {
        const f = setup();
        f.context.chat.push({ is_user: true, send_date: 'one' }, { mes: 'Reply' });
        f.controller.arm('Knock', 1);
        const abort = new AbortController();
        f.controller.preparingReply('regenerate', { signal: abort.signal }, variant === 'preview');
        if (['quiet', 'impersonate'].includes(variant)) f.controller.preparingReply(variant);
        if (variant === 'abort') abort.abort();
        if (variant === 'chat') f.context.chatId = 'B';
        if (variant === 'rearm') f.controller.arm('Other', 1);
        if (variant === 'pause') f.settings.paused = true;
        assert.equal(f.controller.replyPrepared(), false, variant);
        assert.equal(f.settings.temporaryDirection.turnStarted, false, variant);
        assert.equal(f.settings.temporaryDirection.remaining, 1, variant);
    }
});

test('normal send during generation preparation still starts a full first turn', () => {
    const f = setup();
    f.context.chat.push({ is_user: true, send_date: 'old' }, { mes: 'Reply' });
    f.controller.arm('Knock', 1);
    f.controller.preparingReply('normal');
    f.send();
    f.controller.replyPrepared();
    assert.equal(f.settings.temporaryDirection.remaining, 1);
    f.send();
    assert.equal(f.settings.temporaryDirection.remaining, 0);
});

test('three turns ignore group replies, deleted replies and repeated event delivery', () => {
    const f = setup();
    f.context.groupId = 'group';
    f.controller.arm('Knock', 3);
    f.send();
    const userIndex = f.context.chat.length - 1;
    assert.equal(f.controller.userSent(userIndex), false);
    for (let i = 0; i < 5; i++) f.context.chat.push({ mes: 'Group reply' });
    assert.equal(f.settings.temporaryDirection.remaining, 3);
    f.context.chat.length = userIndex + 1;
    f.send();
    assert.equal(f.settings.temporaryDirection.remaining, 2);
    f.send(); f.send();
    assert.equal(f.controller.getText(), '');
});

test('paused, manual and disabled directions do not spend turns', () => {
    const f = setup();
    f.controller.arm('Knock', 3);
    f.settings.paused = true;
    f.send();
    assert.equal(f.settings.temporaryDirection.remaining, 3);
    assert.equal(f.controller.getText(), '');
    f.settings.paused = false;
    f.controller.arm('Manual', null);
    f.send(); f.send();
    assert.equal(f.controller.getText(), 'Manual');
    f.controller.stop();
    f.send();
    assert.equal(f.controller.getText(), '');
});

test('historical insertions, system messages and another chat cannot spend a turn', () => {
    const f = setup();
    f.context.chat.push({ mes: 'Existing reply' });
    f.controller.arm('Knock', 3);
    f.context.chat.splice(0, 0, { is_user: true, mes: 'Historical' });
    assert.equal(f.controller.userSent(0), false);
    f.context.chat.push({ is_user: true, is_system: true, mes: 'System' });
    assert.equal(f.controller.userSent(2), false);
    f.context.chatId = 'B';
    f.send();
    assert.equal(f.settings.temporaryDirection.remaining, 3);
});

test('a delayed user event still closes the turn after the character reply was appended', () => {
    const f = setup();
    f.context.chat.push({ is_user: true, mes: 'First', send_date: 'one' });
    f.controller.arm('Knock', 1);
    f.context.chat.push({ mes: 'Reply' }, { is_user: true, mes: 'Next', send_date: 'two' }, { mes: 'Fast reply' });
    assert.equal(f.controller.userSent(2), true);
    assert.equal(f.settings.temporaryDirection.remaining, 0);
    assert.equal(f.controller.getText(), '');
});

test('string message indices and a repeated rendered event count only once', () => {
    const f = setup();
    f.context.chat.push({ is_user: true, mes: 'First', send_date: 'one' });
    f.controller.arm('Knock', 3);
    f.context.chat.push({ is_user: true, mes: 'Next', send_date: 'two' });
    assert.equal(f.controller.userSent('1'), true);
    assert.equal(f.controller.userSent(1), false);
    assert.equal(f.settings.temporaryDirection.remaining, 2);
});

test('normalization preserves progress through reload and carries old remaining budget forward', () => {
    const f = setup();
    f.controller.arm('Knock', 3);
    f.send(); f.send();
    f.settings.temporaryDirection = normalizeTemporaryDirection(JSON.parse(JSON.stringify(f.settings.temporaryDirection)));
    assert.equal(f.controller.userSent(f.context.chat.length - 1), false);
    assert.equal(f.settings.temporaryDirection.remaining, 2);
    f.send();
    assert.equal(f.settings.temporaryDirection.remaining, 1);
    const old = normalizeTemporaryDirection({ text: 'Old', duration: 3, remaining: 2, countedThrough: 10 });
    assert.equal(old.remaining, 2);
    assert.equal(old.turnStarted, true);
    assert.equal(old.countedThrough, undefined);
    assert.equal(normalizeTemporaryDirection({ text: ' ' }), null);
});

test('directive undo and preset export stay independent of the turn counter', () => {
    const f = setup();
    f.draftState.checkpoint();
    f.controller.arm('Knock', 3);
    f.send(); f.send();
    f.draftState.undo();
    assert.equal(f.settings.temporaryDirection.remaining, 2);
    assert.equal(f.draftState.getStatus().dirty, false);
    assert.equal(f.transfer.getExportPresetSnapshot('draft').temporaryDirection, undefined);
});
