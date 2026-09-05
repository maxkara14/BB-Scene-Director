import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSceneMessages, createSceneEditController, parseSceneChanges, showSceneChanges } from '../scene-edit.js';
import { createFixture } from './helpers.mjs';
import { createDirective, normalizePreset } from '../preset-model.js';
import { stringifyPresetFile, parsePresetImportText } from '../preset-storage.js';

const update = { op: 'update', id: 'original', directive: { name: 'Mood', category: 'focus', value: 80, active: false } };
const add = { op: 'add', directive: { name: 'Pace', category: 'dynamics', value: 65, active: true } };
const response = (...changes) => JSON.stringify({ changes });

function setup(preview = async (_, changes) => changes) {
    const f = createFixture();
    const context = { chat: [{ name: 'Alice', mes: 'Latest event' }] };
    const editor = createSceneEditController({ getSettings: () => f.settings, getContext: () => context, draftState: f.draftState, preview });
    return { ...f, editor, context, signal: new AbortController().signal };
}

test('context keeps recent group speakers in order, excludes system messages and obeys count/text bounds', () => {
    const chat = Array.from({ length: 25 }, (_, i) => ({ name: `Speaker ${i % 3}`, mes: `Message ${i}` }));
    chat.push({ is_system: true, mes: 'Hidden instruction' });
    assert.equal(collectSceneMessages(chat, 0).length, 0);
    assert.equal(collectSceneMessages(chat, 5).length, 5);
    assert.equal(collectSceneMessages(chat)[0].text, 'Message 15');
    assert.equal(collectSceneMessages(chat).at(-1).name, 'Speaker 0');
    const long = collectSceneMessages(Array.from({ length: 10 }, () => ({ mes: 'x'.repeat(5000) })));
    assert.equal(long.reduce((sum, item) => sum + item.text.length, 0), 12000);
    assert.ok(long.every((item) => item.truncated));
});

test('edit prompt contains current state and recent events with bounded character data', () => {
    const f = setup();
    const request = f.editor.prepare('Raise tension', 10, 'x'.repeat(10000));
    const input = JSON.parse(request.userPrompt);
    assert.equal(input.scene.directives[0].id, 'original');
    assert.equal(input.recentMessages[0].text, 'Latest event');
    assert.equal(input.characterContext.length, 6000);
    assert.equal(JSON.parse(f.editor.prepare('Edit', 0).userPrompt).recentMessages.length, 0);
    assert.throws(() => f.editor.prepare('  '));
});

test('partial acceptance changes only selected directives and undoes as one action without writing library', async () => {
    const f = setup(async (_, changes) => [changes[0]]);
    const request = f.editor.prepare('Edit', 10);
    const changes = f.editor.parse(response(update, add), request);
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(await f.editor.review(changes, request, f.signal), 'applied');
    assert.equal(f.settings.directives.length, 1);
    assert.equal(f.settings.directives[0].active, false);
    assert.equal(f.settings.presets[0].items[0].value, 30);
    assert.equal(f.draftState.getStatus().dirty, true);
    f.draftState.undo();
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.draftState.getStatus().canUndo, false);
    f.draftState.redo();
    assert.equal(f.settings.directives[0].value, 80);
});

test('explicit deletion and addition preserve omitted directives', async () => {
    const f = setup();
    f.settings.directives.push(createDirective({ id: 'keep', name: 'Keep', value: 25, active: false }));
    const request = f.editor.prepare('Edit', 10);
    await f.editor.review(f.editor.parse(response({ op: 'delete', id: 'original' }, add), request), request, f.signal);
    assert.deepEqual(f.settings.directives.map((item) => item.name), ['Keep', 'Pace']);
    assert.equal(f.settings.directives[0].active, false);
});

test('locked directives resist model edits and deletes while valid additions remain available', () => {
    const f = setup();
    f.settings.directives[0].locked = true;
    for (const change of [update, { op: 'delete', id: 'original' }]) {
        const request = f.editor.prepare('Edit', 10);
        const changes = f.editor.parse(response(change, add), request);
        assert.equal(changes.length, 1);
        assert.equal(changes[0].op, 'add');
    }
});

test('invalid JSON, ids, duplicate operations and invalid fields cannot partially apply', () => {
    const f = setup();
    const request = f.editor.prepare('Edit', 10);
    for (const raw of ['{"changes":[', response({ ...update, id: 'unknown' }), response(update, update),
        response({ ...update, directive: { ...update.directive, value: 101 } }),
        response({ ...update, directive: { ...update.directive, category: 'unknown' } }),
        response({ ...update, directive: { ...update.directive, active: 'false' } })]) {
        assert.throws(() => parseSceneChanges(raw, request.snapshot));
    }
    assert.equal(f.settings.directives[0].value, 30);
    assert.deepEqual(f.editor.parse('```json\n{"changes":[]}\n```', request), []);
});

test('draft changes before or during review, locking and abort prevent application', async () => {
    for (const mutation of [(f) => { f.settings.directives[0].value = 90; },
        (f) => { f.settings.directives[0].locked = true; },
        (f) => { f.context.chatId = 'another-chat-before-CHAT_CHANGED'; },
        (f) => { f.settings.directives[0].id = 'different-chat-id'; }]) {
        const f = setup(async (_, changes) => { mutation(f); return changes; });
        const request = f.editor.prepare('Edit', 10);
        assert.equal(await f.editor.review(f.editor.parse(response(update), request), request, f.signal), 'stale');
        assert.equal(f.draftState.getStatus().canUndo, false);
    }
    const f = setup(() => { throw new Error('Preview must not open'); });
    const request = f.editor.prepare('Edit', 10);
    const controller = new AbortController();
    controller.abort();
    assert.equal(await f.editor.review(f.editor.parse(response(update), request), request, controller.signal), 'stale');
});

test('cancel and empty result preserve draft and history', async () => {
    const f = setup(async () => []);
    const request = f.editor.prepare('Edit', 10);
    assert.equal(await f.editor.review(f.editor.parse(response(update), request), request, f.signal), 'cancelled');
    assert.equal(await f.editor.review([], request, f.signal), 'empty');
    assert.equal(f.draftState.getStatus().canUndo, false);
});

test('lock survives preset export/import/load and legacy presets stay unlocked', () => {
    const f = setup();
    f.settings.directives[0].locked = true;
    const exported = f.transfer.getExportPresetSnapshot('draft');
    const imported = parsePresetImportText(stringifyPresetFile(exported));
    const preset = normalizePreset(imported.presets[0]);
    assert.equal(preset.items[0].locked, true);
    f.manager.applyPresetItems(preset.items);
    assert.equal(f.settings.directives[0].locked, true);
    f.manager.applyPresetItems([{ name: 'Legacy', value: 70, active: true }]);
    assert.equal(f.settings.directives[0].locked, false);
});

test('preview renders model text as text and returns checked changes only', async () => {
    const previous = globalThis.document;
    globalThis.document = { createElement: (tag) => ({ tag, children: [], append(...children) { this.children.push(...children); } }) };
    try {
        const f = setup();
        const changes = f.editor.parse(response(update, { ...add, directive: { ...add.directive, name: '<img src=x onerror=alert(1)>' } }), f.editor.prepare('Edit', 10));
        const context = { POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1 },
            callGenericPopup: async (root) => {
                root.children[2].children[0].checked = false;
                assert.match(root.children[3].children[1].children[2].textContent, /<img/);
                assert.equal(root.children[3].children[1].children[2].innerHTML, undefined);
                return 1;
            } };
        assert.deepEqual(await showSceneChanges(context, changes, f.settings.categories), [changes[1]]);
        context.callGenericPopup = async () => 0;
        assert.deepEqual(await showSceneChanges(context, changes, f.settings.categories), []);
    } finally { globalThis.document = previous; }
});
