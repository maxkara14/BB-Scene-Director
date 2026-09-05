import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../preset-model.js';
import { createFixture, loadWithHostMocks } from './helpers.mjs';

async function setupUi() {
    const f = createFixture();
    f.settings.masterPreset = { connectionMode: 'custom', availableModels: [], apiKey: '', url: '', model: '', allowMainFallback: false };
    const elements = new Map();
    const handlers = new Map();
    const exports = [];
    let promptUpdates = 0;
    function $(selector) {
        if (typeof selector !== 'string') return selector;
        if (elements.has(selector)) return elements.get(selector);
        const element = {
            length: 1, content: '', value: '', attributes: {}, properties: {}, classes: new Set(),
            on(event, child, handler) {
                handlers.set(`${selector}:${event}:${typeof child === 'string' ? child : ''}`, handler || child);
                return this;
            },
            text(value) { if (value === undefined) return this.content; this.content = value; return this; },
            html(value) { this.content = value; return this; },
            append(value) { this.content += value; return this; },
            empty() { this.content = ''; return this; },
            val(value) { if (value === undefined) return this.value; this.value = value; return this; },
            attr(name, value) { this.attributes[name] = value; return this; },
            prop(name, value) { this.properties[name] = value; return this; },
            toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); return this; },
            addClass() { return this; }, removeClass() { return this; }, toggle() { return this; },
            is() { return Boolean(this.checked); },
            find(child) { return $(`${selector} ${child}`); },
        };
        elements.set(selector, element);
        return element;
    }
    const { createSceneDirectorUiController } = await loadWithHostMocks('director-ui.js', {}, {
        $, requestAnimationFrame() {},
        document: { getElementById: () => null, querySelector: () => ({ insertAdjacentHTML() {} }) },
    });
    let ui;
    ui = createSceneDirectorUiController({
        ...model, draftState: f.draftState,
        getSettings: () => f.settings, getCategories: () => f.settings.categories,
        getContext: () => ({}),
        getIntensityLabel: (value) => String(value),
        groupDirectivesByCategory: (items) => new Map(f.settings.categories.map((category) => [category.id, items.filter((item) => item.category === category.id)])),
        escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        normalizeBaseUrl: (value) => value,
        masterWorkflow: { getGenerationAvailability: () => ({ available: false }), getSupportedMasterProfiles: () => [], getMasterProfileLabel: () => '' },
        notify() {}, saveSettingsDebounced() {}, presetManager: f.manager,
        presetTransfer: {
            handleExportPreset: (source) => exports.push(source),
            createImportFileInput: () => ({ addEventListener() {} }),
        },
        state: {},
        schedulePromptUpdate: () => { promptUpdates++; ui.renderDraftStatus(); },
        updateDirectorPrompt: () => { promptUpdates++; ui.renderDraftStatus(); },
    });
    ui.setupExtensionSettings();
    ui.ensureDirectorHud();
    return { ...f, $, ui, handlers, exports, promptUpdates: () => promptUpdates };
}

test('UI registers distinct export actions and persists an explicit fallback checkbox', async () => {
    const f = await setupUi();
    f.handlers.get('#bb-dir-export-json:click:')();
    f.handlers.get('#bb-dir-export-saved-json:click:')();
    assert.deepEqual(f.exports, ['draft', 'saved']);
    const checkbox = f.$('#bb-dir-master-fallback');
    checkbox.checked = true;
    f.handlers.get('#bb-dir-master-fallback:change:').call(checkbox);
    assert.equal(f.settings.masterPreset.allowMainFallback, true);
    checkbox.checked = false;
    f.handlers.get('#bb-dir-master-fallback:change:').call(checkbox);
    assert.equal(f.settings.masterPreset.allowMainFallback, false);
});

test('slider handler, undo, and redo update scene values, dirty status, and prompt', async () => {
    const f = await setupUi();
    const card = { data: () => 'original', find: () => f.$('slider-details') };
    const slider = { val: () => '90', closest: () => card };
    f.handlers.get('#bb-dir-list:input:.bb-dir-slider').call(slider);
    f.handlers.get('#bb-dir-list:change:.bb-dir-slider').call(slider);
    assert.equal(f.settings.directives[0].value, 90);
    assert.match(f.$('#bb-dir-draft-status').content, /изменён/);
    assert.equal(f.$('#bb-dir-undo').properties.disabled, false);
    f.handlers.get('#bb-dir-undo:click:')();
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.$('#bb-dir-redo').properties.disabled, false);
    f.handlers.get('#bb-dir-redo:click:')();
    assert.equal(f.settings.directives[0].value, 90);
    assert.ok(f.promptUpdates() >= 3);
});

test('preset names remain text in the new status and escaped markup in the dropdown', async () => {
    const f = await setupUi();
    f.settings.presets[0].name = '<img src=x onerror=alert(1)>';
    f.ui.renderDraftStatus();
    f.ui.renderPresetsDropdown();
    assert.equal(f.$('#bb-dir-draft-status').content, '<img src=x onerror=alert(1)> — без изменений');
    assert.doesNotMatch(f.$('#bb-dir-preset-select').content, /<img/);
    assert.match(f.$('#bb-dir-preset-select').content, /&lt;img/);
});
