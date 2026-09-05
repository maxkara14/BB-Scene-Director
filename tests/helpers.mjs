import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../preset-model.js';
import { createDraftState } from '../draft-state.js';
import { createPresetManager } from '../preset-manager.js';
import { createPresetTransferController } from '../preset-transfer.js';

// Evaluate the real extension entry points with a synthetic SillyTavern host.
// Local pure modules are imported normally; browser/network dependencies are replaced explicitly.
export async function loadWithHostMocks(file, mocks, globals = {}) {
    const url = new URL(`../${file}`, import.meta.url);
    let source = await readFile(url, 'utf8');
    const bindings = { console, ...globals };
    const importPattern = /import\s+\{([\s\S]*?)\}\s+from\s+'([^']+)';/g;
    for (const [, names, path] of source.matchAll(importPattern)) {
        const imported = mocks[path] ?? await import(new URL(path, url));
        for (const spec of names.split(',').map((name) => name.trim()).filter(Boolean)) {
            const [name, alias = name] = spec.split(/\s+as\s+/);
            if (!(name in imported)) throw new Error(`Missing mock export: ${path} / ${name}`);
            bindings[alias] = imported[name];
        }
    }
    const exports = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map((match) => match[1]);
    source = source.replace(importPattern, '').replace(/^export /gm, '');
    return vm.runInNewContext(`${source}\n;({${exports.join(',')}});`, bindings, { filename: file });
}

export function createFixture() {
    const categories = model.getDefaultCategories();
    const directive = model.createDirective({ id: 'original', name: 'Mood', category: 'focus', value: 30, active: true });
    const settings = {
        directives: [directive], categories,
        expandedCategories: model.createDefaultExpandedCategories(categories),
        presets: [], lastActivePreset: null,
    };
    let selected = null;
    let confirms = true;
    let confirmationCount = 0;
    const messages = [];
    const getSettings = () => settings;
    const draftState = createDraftState({ getSettings });
    const dependencies = {
        ...model, draftState, getSettings, getCategories: () => settings.categories,
        getSelectedPresetIndex: () => selected,
        setSelectedPresetIndex: (index) => { selected = index; },
        getCurrentDraftItems: () => settings.directives.map(model.createPresetItemFromDirective),
        normalizeCategories: (raw, items, presets) => model.normalizeCategories(raw, items, presets, settings.categories),
        normalizePresetItem: (item, byName) => model.normalizePresetItem(item, byName, settings.categories),
        createDirective: (item) => model.createDirective(item, settings.categories),
        getUniquePresetName: (name) => name,
        confirmAction: async () => { confirmationCount++; return typeof confirms === 'function' ? confirms() : confirms; },
        promptText: async () => 'New preset',
        notify: (...args) => messages.push(args),
        saveSettingsDebounced() {}, renderDirectorHud() {}, renderPresetsDropdown() {},
        updateDirectorPrompt() {}, flashButton() {}, applyExpandedCategoriesFromItems() {},
    };
    const transfer = createPresetTransferController(dependencies);
    const manager = createPresetManager({ ...dependencies, createPresetRecord: transfer.createPresetRecord });
    settings.presets.push(transfer.createPresetRecord('Original', dependencies.getCurrentDraftItems(), { categories }));
    settings.lastActivePreset = 0;
    selected = 0;
    return {
        settings, draftState, transfer, manager, messages,
        select: (index) => { selected = index; },
        confirm: (value) => { confirms = value; },
        confirmationCount: () => confirmationCount,
    };
}
