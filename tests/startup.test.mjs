import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWithHostMocks } from './helpers.mjs';

async function start(settings) {
    const extension_settings = settings ? { 'BB-Scene-Director': settings } : {};
    const window = {};
    const events = new Map();
    const prompts = [];
    let workflowState;
    let ready;
    const context = {
        chatId: 'first-chat', characterId: 0, chatMetadata: {}, saveMetadata: async () => {},
        eventSource: { on: (event, callback) => events.set(event, callback) },
        event_types: { APP_READY: 'ready', CHAT_CHANGED: 'changed', CHAT_RENAMED: 'renamed', GENERATE_AFTER_DATA: 'generated' },
    };
    await loadWithHostMocks('index.js', {
        '../../../../script.js': {
            saveSettingsDebounced() {}, setExtensionPrompt: (...args) => prompts.push(args),
            extension_prompt_roles: { SYSTEM: 0 }, extension_prompt_types: { IN_CHAT: 1 },
        },
        '../../../extensions.js': { extension_settings },
        './master-prompts.js': { createMasterPromptBuilder: () => ({}) },
        './master-workflow.js': { createMasterWorkflow: ({ state }) => { workflowState = state; return {}; } },
        './director-ui.js': { createSceneDirectorUiController: () => ({
            renderDraftStatus() {}, renderPresetsDropdown() {}, renderDirectorHud() {}, setupExtensionSettings() {},
            ensureDirectorHud() {}, renderMasterControls() {}, updateHudTopOffset() {}, toggleHudVisibility() {},
        }) },
    }, {
        window: Object.assign(window, { addEventListener() {} }),
        jQuery: (callback) => { ready = callback(); },
        $: () => ({ length: 0 }),
        SillyTavern: { getContext: () => context },
    });
    await ready;
    events.get('ready')();
    return { settings: extension_settings['BB-Scene-Director'], window, context, events, prompts, workflowState };
}

test('schema 6 with inactive directives starts and backs up the entire old draft exactly once', async () => {
    const input = {
        schemaVersion: 6, v2PercentageMigrated: true, presets: [],
        directives: [
            { id: 'on', name: 'Active', category: 'focus', value: 70, active: true },
            { id: 'off', name: 'Inactive', category: 'plot', value: 20, active: false },
        ],
    };
    const first = await start(input);
    assert.equal(first.settings.schemaVersion, 8);
    assert.equal(first.settings.directives.length, 1);
    assert.equal(first.settings.presets.length, 2);
    assert.equal(first.settings.presets[0].items.length, 2);
    assert.equal(first.settings.presets[0].items[1].active, false);
    await start(first.settings);
    assert.equal(first.settings.presets.length, 2);
});

test('current settings preserve inactive directives, prompt values, macro pause, and fallback choice', async () => {
    const { settings, window } = await start({
        schemaVersion: 8, v2PercentageMigrated: true, presets: [],
        directives: [
            { id: 'on', name: 'Mood', category: 'focus', value: 70, active: true },
            { id: 'off', name: 'Inactive', category: 'plot', value: 20, active: false },
        ],
        masterPreset: { connectionMode: 'custom', url: 'https://example.invalid/v1', model: 'test', allowMainFallback: true },
    });
    assert.equal(settings.directives.length, 2);
    assert.match(window.bbGetSceneDirectorPrompt(), /Mood: 70%/);
    assert.doesNotMatch(window.bbGetSceneDirectorPrompt(), /Inactive/);
    settings.paused = true;
    assert.equal(window.bbGetSceneDirectorPrompt(), '');
    assert.equal(settings.masterPreset.allowMainFallback, true);
});

test('new and upgraded settings disable fallback by default', async () => {
    assert.equal((await start()).settings.masterPreset.allowMainFallback, false);
    assert.equal((await start({ schemaVersion: 8 })).settings.masterPreset.allowMainFallback, false);
});

test('CHAT_CHANGED clears the old prompt, cancels generation, and restores the previous chat on return', async () => {
    const f = await start({
        schemaVersion: 8, v2PercentageMigrated: true, presets: [],
        directives: [{ id: 'on', name: 'Mood', category: 'focus', value: 70, active: true }],
    });
    const firstMetadata = f.context.chatMetadata;
    const controller = new AbortController();
    f.workflowState.masterAbortController = controller;
    f.context.chatId = 'second-chat';
    f.context.chatMetadata = {};
    assert.equal(f.window.bbGetSceneDirectorPrompt(), '');
    f.events.get('changed')();
    assert.equal(controller.signal.aborted, true);
    assert.equal(f.settings.directives.length, 0);
    assert.equal(f.prompts.at(-1)[1], '');
    f.context.chatId = 'first-chat';
    f.context.chatMetadata = firstMetadata;
    f.events.get('changed')();
    assert.match(f.prompts.at(-1)[1], /Mood: 70%/);
});
