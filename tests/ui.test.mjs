import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../preset-model.js';
import { createFixture, loadWithHostMocks } from './helpers.mjs';
import { createTemporaryDirectionController } from '../temporary-direction.js';

async function setupUi() {
    const f = createFixture();
    f.settings.masterPreset = { connectionMode: 'custom', availableModels: [], apiKey: '', url: '', model: '', allowMainFallback: false };
    const elements = new Map();
    const handlers = new Map();
    const exports = [];
    const generations = [];
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
            toggleClass(name, on = !this.classes.has(name)) { if (on) this.classes.add(name); else this.classes.delete(name); return this; },
            hasClass(name) { return this.classes.has(name); },
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
    const temporaryDirection = createTemporaryDirectionController({
        getSettings: () => f.settings, getContext: () => ({ chat: [] }), isCurrentChat: () => true,
        save() {}, changed: () => ui.renderTemporaryDirection(),
    });
    ui = createSceneDirectorUiController({
        temporaryDirection,
        ...model, draftState: f.draftState,
        getSettings: () => f.settings, getCategories: () => f.settings.categories,
        getContext: () => ({}),
        getIntensityLabel: (value) => String(value),
        groupDirectivesByCategory: (items) => new Map(f.settings.categories.map((category) => [category.id, items.filter((item) => item.category === category.id)])),
        escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        normalizeBaseUrl: (value) => value,
        masterWorkflow: { generateMasterPreset: (...args) => generations.push(args), getGenerationAvailability: () => ({ available: false }), getSupportedMasterProfiles: () => [], getMasterProfileLabel: () => '' },
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
    return { ...f, $, ui, handlers, exports, generations, promptUpdates: () => promptUpdates };
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

test('edit controls dispatch selected context and lock toggling is undoable', async () => {
    const f = await setupUi();
    f.$('#bb-dir-master-action').val('edit');
    f.$('#bb-dir-master-context').val('5');
    f.$('#bb-dir-master-request').val('Raise tension');
    f.handlers.get('#bb-dir-master-action:change:')();
    f.handlers.get('#bb-dir-master-generate:click:')();
    assert.equal(f.generations[0][0], 'Raise tension');
    assert.equal(f.generations[0][1].mode, 'edit');
    assert.equal(f.generations[0][1].messageCount, 5);
    const button = { closest: () => ({ data: () => 'original' }) };
    f.handlers.get('#bb-dir-list:click:.bb-dir-lock').call(button);
    assert.equal(f.settings.directives[0].locked, true);
    assert.equal(f.draftState.getStatus().dirty, true);
    f.draftState.undo();
    assert.equal(f.settings.directives[0].locked, false);
});

test('temporary form arms the chosen duration, preserves unsubmitted text on rerender, and stops safely', async () => {
    const f = await setupUi();
    f.$('#bb-dir-temporary-text').val('<img src=x onerror=alert(1)>');
    f.$('#bb-dir-temporary-duration').val('3');
    f.handlers.get('#bb-dir-temporary-arm:click:')();
    assert.equal(f.settings.temporaryDirection.remaining, 3);
    assert.equal(f.settings.temporaryDirection.text, '<img src=x onerror=alert(1)>');
    f.$('#bb-dir-temporary-text').val('Unsubmitted edit');
    f.ui.renderDirectorHud();
    assert.equal(f.$('#bb-dir-temporary-text').val(), 'Unsubmitted edit');
    f.handlers.get('#bb-dir-temporary-stop:click:')();
    assert.equal(f.settings.temporaryDirection.enabled, false);
});

test('temporary section toggles keyboard access and expanded state without losing input', async () => {
    const f = await setupUi();
    const block = f.$('.bb-dir-temporary');
    block.classes.add('is-collapsed');
    f.$('#bb-dir-temporary-text').val('Pending text');
    const toggle = f.handlers.get('#bb-dir-temporary-toggle:click:');
    toggle();
    assert.equal(f.$('#bb-dir-temporary-toggle').attributes['aria-expanded'], 'true');
    assert.equal(f.$('#bb-dir-temporary-body').properties.inert, false);
    toggle();
    assert.equal(f.$('#bb-dir-temporary-toggle').attributes['aria-expanded'], 'false');
    assert.equal(f.$('#bb-dir-temporary-body').properties.inert, true);
    assert.equal(f.$('#bb-dir-temporary-text').val(), 'Pending text');
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

test('opening and closing the HUD keeps keyboard access and expanded state in sync', async () => {
    const f = await setupUi();
    const toggle = f.$('#bb-director-toggle');
    const hud = f.$('#bb-director-hud');
    f.handlers.get('#bb-director-toggle:click:')();
    assert.equal(hud.properties.inert, false);
    assert.equal(toggle.attributes['aria-expanded'], 'true');
    f.handlers.get('#bb-director-toggle:click:')();
    assert.equal(hud.properties.inert, true);
    assert.equal(toggle.attributes['aria-expanded'], 'false');
});

test('collapsed toolbar and footer exclude hidden controls until reopened', async () => {
    const f = await setupUi();
    for (const name of ['toolbar', 'footer']) {
        f.handlers.get(`#bb-dir-${name}-toggle:click:`)();
        assert.equal(f.$(`#bb-dir-${name}-body`).properties.inert, true);
        f.handlers.get(`#bb-dir-${name}-toggle:click:`)();
        assert.equal(f.$(`#bb-dir-${name}-body`).properties.inert, false);
    }
});

test('directive tooltip preserves full names without introducing HTML attributes', async () => {
    const f = await setupUi();
    f.settings.directives[0].name = 'Long title " onfocus="alert(1)';
    f.ui.renderDirectorHud();
    const markup = f.$('#bb-dir-list').content;
    assert.match(markup, /title="Long title &quot; onfocus=&quot;alert\(1\)"/);
    assert.doesNotMatch(markup, /" onfocus="/);
    assert.match(markup, /aria-label="Название директивы"/);
    assert.match(markup, /aria-label="Интенсивность директивы"/);
});
