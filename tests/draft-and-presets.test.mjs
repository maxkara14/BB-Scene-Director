import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftState } from '../draft-state.js';
import { parsePresetImportText, stringifyPresetFile } from '../preset-storage.js';
import { createFixture } from './helpers.mjs';

test('dirty state ignores generated IDs and tracks values, categories, and inactive directives', () => {
    const { settings, draftState } = createFixture();
    settings.directives[0].id = 'fresh-instance';
    assert.equal(draftState.getStatus().dirty, false);
    settings.directives[0].value = 90;
    assert.equal(draftState.getStatus().dirty, true);
    settings.directives[0].value = 30;
    settings.directives[0].active = false;
    assert.equal(draftState.getStatus().dirty, true);
    settings.directives[0].active = true;
    settings.categories[0].hint = 'Updated';
    assert.equal(draftState.getStatus().dirty, true);
});

test('one slider gesture is one undo step; redo and a new edit preserve correct history', () => {
    const { settings, draftState } = createFixture();
    for (const value of [40, 70, 90]) {
        draftState.checkpoint('slider:original');
        settings.directives[0].value = value;
    }
    draftState.endGroup();
    assert.equal(draftState.undo(), true);
    assert.equal(settings.directives[0].value, 30);
    assert.equal(draftState.getStatus().canUndo, false);
    assert.equal(draftState.redo(), true);
    assert.equal(settings.directives[0].value, 90);
    draftState.undo();
    draftState.checkpoint();
    settings.directives[0].name = 'New name';
    assert.equal(draftState.redo(), false);
});

test('undo restores removed categories and directives without restoring deleted library presets', async () => {
    const fixture = createFixture();
    await fixture.manager.handleDeleteCategory('focus');
    assert.equal(fixture.settings.directives.length, 0);
    fixture.settings.presets.length = 0;
    fixture.draftState.undo();
    assert.equal(fixture.settings.directives[0].name, 'Mood');
    assert.equal(fixture.settings.categories[0].id, 'focus');
    assert.equal(fixture.settings.presets.length, 0);
    assert.equal(fixture.settings.lastActivePreset, null);
});

test('loading protects dirty drafts, while clean loads do not ask; accepted replacement is undoable', async () => {
    const f = createFixture();
    await f.manager.handleLoadPreset();
    assert.equal(f.confirmationCount(), 0);
    f.settings.directives[0].value = 90;
    f.confirm(false);
    await f.manager.handleLoadPreset();
    assert.equal(f.settings.directives[0].value, 90);
    f.confirm(true);
    await f.manager.handleLoadPreset();
    assert.equal(f.settings.directives[0].value, 30);
    f.draftState.undo();
    assert.equal(f.settings.directives[0].value, 90);
    assert.equal(f.draftState.getStatus().dirty, true);
});

test('draft export round-trips current values; saved export stays independent of the draft', () => {
    const f = createFixture();
    f.settings.directives[0].value = 90;
    const draft = f.transfer.getExportPresetSnapshot('draft');
    const saved = f.transfer.getExportPresetSnapshot('saved');
    assert.equal(parsePresetImportText(stringifyPresetFile(draft)).presets[0].items[0].value, 90);
    assert.equal(saved.items[0].value, 30);
    saved.items[0].value = 10;
    assert.equal(f.settings.presets[0].items[0].value, 30);
    f.select(null);
    assert.equal(f.transfer.getExportPresetSnapshot('saved'), null);
    assert.equal(f.transfer.getExportPresetSnapshot('draft').items[0].value, 90);
});

test('saving clears the dirty indicator; undo resolves active preset by ID after library changes', async () => {
    const f = createFixture();
    f.draftState.checkpoint();
    f.settings.directives[0].value = 90;
    await f.manager.handleSaveNewPreset();
    assert.equal(f.draftState.getStatus().dirty, false);
    const originalId = f.settings.presets[0].id;
    f.settings.presets.reverse();
    f.draftState.undo();
    assert.equal(f.settings.presets[f.settings.lastActivePreset].id, originalId);
    assert.equal(f.settings.directives[0].value, 30);
});

test('history is bounded and a fresh page session starts with no undo history', () => {
    const f = createFixture();
    const history = createDraftState({ getSettings: () => f.settings, historyLimit: 2 });
    for (const value of [40, 50, 60]) {
        history.checkpoint();
        f.settings.directives[0].value = value;
    }
    history.undo(); history.undo();
    assert.equal(history.undo(), false);
    assert.equal(f.settings.directives[0].value, 40);
    assert.equal(createDraftState({ getSettings: () => f.settings }).getStatus().canUndo, false);
});

test('confirmation cannot load a preset over a scene changed while the dialog was open', async () => {
    const f = createFixture();
    f.settings.directives[0].value = 70;
    f.confirm(() => { f.settings.directives[0].value = 95; return true; });
    await f.manager.handleLoadPreset();
    assert.equal(f.settings.directives[0].value, 95);
    assert.equal(f.draftState.getStatus().canUndo, false);
});

test('category deletion and preset overwrite are cancelled when the scene changes during confirmation', async () => {
    const f = createFixture();
    f.confirm(() => { f.settings.directives[0].value = 95; return true; });
    await f.manager.handleDeleteCategory('focus');
    assert.equal(f.settings.directives.length, 1);
    f.settings.directives[0].value = 70;
    await f.manager.handleUpdatePreset();
    assert.equal(f.settings.presets[0].items[0].value, 30);
});
