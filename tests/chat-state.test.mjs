import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatState } from '../chat-state.js';
import { createDraftState } from '../draft-state.js';
import { createFixture } from './helpers.mjs';
import { normalizeTemporaryDirection } from '../temporary-direction.js';

function setup() {
    const f = createFixture();
    f.settings.paused = false;
    const saved = [];
    const chats = new Map();
    let current;
    const open = (chatId, characterId = 0, groupId = null) => {
        const key = JSON.stringify([chatId, characterId, groupId]);
        if (!chats.has(key)) {
            chats.set(key, {
                chatId, characterId, groupId, chatMetadata: { anotherExtension: 'preserve' },
                saveMetadata: async () => { saved.push(key); },
            });
        }
        current = chats.get(key);
        return current;
    };
    open('A');
    const controller = createChatState({
        getSettings: () => f.settings, getContext: () => current,
        createPresetRecord: f.transfer.createPresetRecord, getUniquePresetName: (name) => name,
        saveGlobalSettings() {}, notify: (...args) => f.messages.push(args),
    });
    return { ...f, controller, open, saved, context: () => current };
}

test('old shared scene goes only to the first chat and is backed up once', () => {
    const f = setup();
    f.settings.paused = true;
    f.controller.activate();
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.context().chatMetadata['BB-Scene-Director'].paused, true);
    assert.equal(f.settings.presets.length, 2);
    const backup = f.settings.presets[1];
    assert.equal(backup.items[0].value, 30);
    f.open('B');
    f.controller.activate();
    assert.equal(f.settings.directives.length, 0);
    assert.equal(f.settings.paused, false);
    assert.equal(f.settings.lastActivePreset, null);
    assert.equal(f.settings.presets.length, 2);
    f.open('A');
    f.controller.activate();
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.settings.paused, true);
});

test('per-chat edits persist independently and leave other metadata intact', () => {
    const f = setup();
    f.controller.activate();
    f.settings.directives[0].value = 95;
    f.settings.directives[0].locked = true;
    f.settings.directives[0].description = 'Let silences build tension';
    f.settings.expandedCategories.focus = true;
    f.controller.save();
    f.open('B'); f.controller.activate();
    f.settings.paused = true;
    f.controller.save();
    f.open('A'); f.controller.activate();
    assert.equal(f.settings.directives[0].value, 95);
    assert.equal(f.settings.directives[0].locked, true);
    assert.equal(f.settings.directives[0].description, 'Let silences build tension');
    assert.equal(f.settings.paused, false);
    assert.equal(f.settings.expandedCategories.focus, true);
    assert.equal(f.context().chatMetadata.anotherExtension, 'preserve');
    f.open('B'); f.controller.activate();
    assert.equal(f.settings.paused, true);
});

test('temporary direction text and spent duration restore per chat and survive a fresh controller', () => {
    const f = setup();
    f.controller.activate();
    f.settings.temporaryDirection = normalizeTemporaryDirection({ text: 'Knock', duration: 3, remaining: 2, countBy: 'user-turn', turnStarted: true, lastUserKey: 'saved-user-message' });
    f.controller.save();
    f.open('B'); f.controller.activate();
    assert.equal(f.settings.temporaryDirection, null);
    f.open('A'); f.controller.activate();
    assert.equal(f.settings.temporaryDirection.remaining, 2);
    const fresh = createChatState({
        getSettings: () => f.settings, getContext: f.context,
        createPresetRecord: f.transfer.createPresetRecord, getUniquePresetName: (name) => name,
        saveGlobalSettings() {}, notify() {},
    });
    f.settings.temporaryDirection = null;
    fresh.activate();
    assert.equal(f.settings.temporaryDirection.text, 'Knock');
    assert.equal(f.settings.temporaryDirection.lastUserKey, 'saved-user-message');
});

test('chat identity distinguishes characters, groups, and chats of the same character', () => {
    const f = setup();
    f.controller.activate();
    const firstScope = f.controller.getScope();
    f.open('A', 1); f.controller.activate();
    assert.notEqual(f.controller.getScope(), firstScope);
    assert.equal(f.settings.directives.length, 0);
    f.open('A', 0, 'group'); f.controller.activate();
    assert.notEqual(f.controller.getScope(), firstScope);
    assert.equal(f.settings.directives.length, 0);
});

test('switching context before CHAT_CHANGED cannot write the previous scene into the new chat', () => {
    const f = setup();
    f.controller.activate();
    const next = f.open('B');
    f.settings.directives[0].value = 95;
    f.controller.save();
    assert.equal(f.controller.isCurrentChat(), false);
    assert.equal(next.chatMetadata['BB-Scene-Director'], undefined);
    f.controller.activate();
    assert.equal(f.settings.directives.length, 0);
});

test('slider input updates metadata immediately and sends one save at the end of the gesture', () => {
    const f = setup();
    f.controller.activate();
    const initialSaves = f.saved.length;
    for (const value of [40, 70, 90]) {
        f.settings.directives[0].value = value;
        f.controller.save({ deferMetadata: true });
    }
    assert.equal(f.saved.length, initialSaves);
    assert.equal(f.context().chatMetadata['BB-Scene-Director'].directives[0].value, 90);
    f.controller.save();
    assert.equal(f.saved.length, initialSaves + 1);
    f.controller.save();
    assert.equal(f.saved.length, initialSaves + 1);
});

test('stored metadata restores after library reordering; deleted presets do not erase scene content', () => {
    const f = setup();
    f.controller.activate();
    const presetId = f.settings.presets[0].id;
    f.settings.presets.reverse();
    f.open('B'); f.controller.activate();
    f.open('A'); f.controller.activate();
    assert.equal(f.settings.presets[f.settings.lastActivePreset].id, presetId);
    f.settings.presets = [];
    f.controller.activate();
    assert.equal(f.settings.lastActivePreset, null);
    assert.equal(f.settings.directives[0].value, 30);
});

test('no active chat consumes no legacy scene and saves no metadata', () => {
    const f = setup();
    f.open(undefined);
    f.controller.activate();
    f.controller.save();
    assert.equal(f.settings.chatScenesInitialized, undefined);
    assert.equal(f.settings.directives.length, 1);
    assert.equal(f.saved.length, 0);
    f.open('A'); f.controller.activate();
    assert.equal(f.settings.directives[0].value, 30);
});

test('chat scope prevents identical scenes from sharing generation fingerprints; history can be cleared', () => {
    const f = setup();
    f.controller.activate();
    const history = createDraftState({ getSettings: () => f.settings, getScope: f.controller.getScope });
    f.settings.directives = [];
    f.settings.lastActivePreset = null;
    const signature = history.getSignature();
    history.checkpoint();
    f.controller.save();
    f.open('B'); f.controller.activate(); history.clear();
    assert.notEqual(history.getSignature(), signature);
    assert.equal(history.getStatus().canUndo, false);
    assert.equal(history.getStatus().canRedo, false);
});

test('metadata save failure reports an error and permits retry without losing the scene', async () => {
    const f = setup();
    f.controller.activate();
    f.context().saveMetadata = async () => { throw new Error('offline'); };
    f.settings.directives[0].value = 95;
    f.controller.save();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(f.messages.some(([level]) => level === 'error'));
    let retries = 0;
    f.context().saveMetadata = async () => { retries++; };
    f.controller.save();
    assert.equal(retries, 1);
    assert.equal(f.settings.directives[0].value, 95);
});

test('a fresh controller restores existing chat metadata and does not repeat the old-scene backup', () => {
    const f = setup();
    f.controller.activate();
    f.settings.directives[0].value = 95;
    f.settings.paused = true;
    f.controller.save();
    const context = f.context();
    const restoredSettings = JSON.parse(JSON.stringify(f.settings));
    restoredSettings.directives = [];
    const reloaded = createChatState({
        getSettings: () => restoredSettings, getContext: () => context,
        createPresetRecord() { throw new Error('Unexpected repeated migration'); },
        saveGlobalSettings() {}, notify() {},
    });
    reloaded.activate();
    assert.equal(restoredSettings.directives[0].value, 95);
    assert.equal(restoredSettings.paused, true);
    assert.equal(restoredSettings.presets.length, 2);
});
