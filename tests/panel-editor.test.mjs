import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelEditSession } from '../panel-editor.js';
import { createFixture } from './helpers.mjs';
import { normalizePreset } from '../preset-model.js';

function setup(kind = 'directive') {
    const f = createFixture();
    let scope = 'chat-a';
    const session = createPanelEditSession({ kind, id: kind === 'directive' ? 'original' : 'focus', getSettings: () => f.settings, getScope: () => scope, draftState: f.draftState });
    return { ...f, session, switchChat: () => { scope = 'chat-b'; } };
}
const fields = { name: 'New name', description: '<script>text</script>', category: 'dynamics', locked: true };
test('opening/cancelling is read-only; Save batches fields in one undo step', () => {
    const f = setup();
    f.session.initial.description = 'Unsaved copy';
    assert.equal(f.settings.directives[0].description, '');
    assert.equal(f.draftState.getStatus().canUndo, false);
    assert.equal(f.session.save(fields), 'saved');
    assert.equal(f.settings.directives[0].description, fields.description);
    assert.equal(f.settings.directives[0].locked, true);
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.settings.directives[0].active, true);
    assert.equal(f.settings.expandedCategories.dynamics, true);
    f.draftState.undo();
    assert.equal(f.settings.directives[0].name, 'Mood');
    assert.equal(f.settings.directives[0].locked, false);
    assert.equal(f.draftState.getStatus().canUndo, false);
    f.draftState.redo();
    assert.equal(f.settings.directives[0].name, fields.name);
});
test('scope and scene changes reject save and deletion', () => {
    for (const mutation of [f => f.switchChat(), f => { f.settings.directives[0].value = 90; }, f => { f.settings.directives = []; }]) {
        const f = setup(); mutation(f);
        assert.equal(f.session.save(fields), 'stale');
        assert.equal(f.session.remove(), 'stale');
        assert.equal(f.draftState.getStatus().canUndo, false);
    }
});
test('unchanged and invalid forms do not add history', () => {
    const f = setup();
    assert.equal(f.session.save({ ...f.session.initial }), 'unchanged');
    assert.equal(f.session.save({ ...fields, name: ' ' }), 'invalid');
    assert.equal(f.session.save({ ...fields, category: 'missing' }), 'invalid');
    assert.equal(f.draftState.getStatus().canUndo, false);
});
test('group hint can be cleared and exported without changing its prompt label', () => {
    const f = setup('group');
    const promptLabel = f.session.initial.promptLabel;
    assert.equal(f.session.save({ name: 'Group name', hint: '' }), 'saved');
    const preset = normalizePreset(f.transfer.getExportPresetSnapshot('draft'));
    assert.equal(preset.categories[0].hint, '');
    assert.equal(preset.categories[0].promptLabel, promptLabel);
    f.draftState.undo();
    assert.ok(f.settings.categories[0].hint);
});
test('deleting a directive is undoable and leaves library unchanged', () => {
    const f = setup();
    assert.equal(f.session.remove(), 'saved');
    assert.equal(f.settings.directives.length, 0);
    assert.equal(f.settings.presets[0].items.length, 1);
    f.draftState.undo();
    assert.equal(f.settings.directives[0].id, 'original');
});
