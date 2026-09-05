import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWithHostMocks } from './helpers.mjs';

async function start(settings) {
    const extension_settings = settings ? { 'BB-Scene-Director': settings } : {};
    const window = {};
    const events = new Map();
    const prompts = [];
    let workflowState;
    let temporaryController;
    let ready;
    const context = {
        chatId: 'first-chat', characterId: 0, chat: [], chatMetadata: {}, saveMetadata: async () => {},
        eventSource: { on: (event, callback) => events.set(event, callback) },
        event_types: { APP_READY: 'ready', CHAT_CHANGED: 'changed', CHAT_RENAMED: 'renamed', GENERATE_AFTER_DATA: 'generated', MESSAGE_SENT: 'sent', USER_MESSAGE_RENDERED: 'user-rendered', GENERATION_STARTED: 'start', MESSAGE_RECEIVED: 'received', GENERATION_STOPPED: 'stop' },
    };
    await loadWithHostMocks('index.js', {
        '../../../../script.js': {
            saveSettingsDebounced() {}, setExtensionPrompt: (...args) => prompts.push(args),
            extension_prompt_roles: { SYSTEM: 0 }, extension_prompt_types: { IN_CHAT: 1 },
        },
        '../../../extensions.js': { extension_settings },
        './master-prompts.js': { createMasterPromptBuilder: () => ({}) },
        './master-workflow.js': { createMasterWorkflow: ({ state }) => { workflowState = state; return {}; } },
        './director-ui.js': { createSceneDirectorUiController: ({ temporaryDirection }) => { temporaryController = temporaryDirection; return {
            renderTemporaryDirection() {},
            renderDraftStatus() {}, renderPresetsDropdown() {}, renderDirectorHud() {}, setupExtensionSettings() {},
            ensureDirectorHud() {}, renderMasterControls() {}, updateHudTopOffset() {}, toggleHudVisibility() {},
        }; } },
    }, {
        window: Object.assign(window, { addEventListener() {} }),
        jQuery: (callback) => { ready = callback(); },
        $: () => ({ length: 0 }),
        SillyTavern: { getContext: () => context },
    });
    await ready;
    events.get('ready')();
    return { settings: extension_settings['BB-Scene-Director'], window, context, events, prompts, workflowState, temporaryController };
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

test('user-message events control expiry and update the next prompt before generation', async () => {
    const f = await start({ schemaVersion: 8, directives: [], presets: [] });
    const saved = [];
    f.context.saveMetadata = async () => saved.push(f.context.chatMetadata['BB-Scene-Director'].temporaryDirection.remaining);
    f.temporaryController.arm('Knock', 1);
    assert.equal(f.events.has('start'), true);
    assert.equal(f.events.has('received'), false);
    assert.equal(f.events.has('stop'), false);
    f.context.chat.push({ is_user: true, mes: 'First', send_date: 'one' });
    f.events.get('sent')(0);
    assert.match(f.window.bbGetSceneDirectorPrompt(), /Knock/);
    f.context.chat.push({ mes: 'Reply' });
    assert.match(f.window.bbGetSceneDirectorPrompt(), /Knock/);
    f.context.chat[1].mes = 'Rerolled reply';
    assert.equal(f.settings.temporaryDirection.remaining, 1);
    f.context.chat.push({ is_user: true, mes: 'Next', send_date: 'two' });
    f.events.get('sent')(2);
    assert.equal(f.window.bbGetSceneDirectorPrompt(), '');
    assert.equal(f.context.chatMetadata['BB-Scene-Director'].temporaryDirection.remaining, 0);
    assert.deepEqual(saved, [1, 1, 0]);
});

test('reroll starts the existing turn without spending it and next user removes the injected direction', async () => {
    const f = await start({ schemaVersion: 8, directives: [], presets: [] });
    f.context.chat.push({ is_user: true, send_date: 'one' }, { mes: 'Old reply' });
    f.temporaryController.arm('Knock', 1);
    f.events.get('start')('regenerate', {}, false);
    f.events.get('generated')({}, true);
    assert.equal(f.settings.temporaryDirection.turnStarted, false);
    f.events.get('generated')({}, false);
    assert.equal(f.settings.temporaryDirection.turnStarted, true);
    assert.equal(f.settings.temporaryDirection.remaining, 1);
    assert.match(f.prompts.at(-1)[1], /Knock/);
    f.context.chat.push({ is_user: true, send_date: 'two' });
    f.events.get('sent')(2);
    assert.equal(f.settings.temporaryDirection.remaining, 0);
    assert.equal(f.prompts.at(-1)[1], '');
});

test('existing user turn and remaining budget survive switching chats', async () => {
    const f = await start({ schemaVersion: 8, directives: [], presets: [] });
    f.context.chat.push({ is_user: true, mes: 'Existing', send_date: 'one' });
    f.temporaryController.arm('Knock', 1);
    const firstMetadata = f.context.chatMetadata;
    f.context.chatId = 'B'; f.context.chatMetadata = {};
    f.events.get('changed')();
    assert.equal(f.settings.temporaryDirection, null);
    f.context.chatId = 'first-chat'; f.context.chatMetadata = firstMetadata;
    f.events.get('changed')();
    assert.equal(f.settings.temporaryDirection.turnStarted, true);
    f.context.chat.push({ is_user: true, mes: 'Next', send_date: 'two' });
    f.events.get('sent')(1);
    assert.equal(f.window.bbGetSceneDirectorPrompt(), '');
});

test('rendered user events accept string indices and remove the whole temporary block without double counting', async () => {
    const f = await start({ schemaVersion: 8, directives: [{ name: 'Mood', active: true, value: 70 }], presets: [] });
    f.context.chat.push({ is_user: true, mes: 'First', send_date: 'one' });
    f.temporaryController.arm('Knock', 1);
    assert.match(f.window.bbGetSceneDirectorPrompt(), /TEMPORARY SCENE DIRECTION[\s\S]*Knock[\s\S]*END SCENE DIRECTOR/);
    f.context.chat.push({ mes: 'Reply' }, { is_user: true, mes: 'Next', send_date: 'two' });
    f.events.get('user-rendered')('2');
    f.events.get('sent')(2);
    const prompt = f.window.bbGetSceneDirectorPrompt();
    assert.equal(f.settings.temporaryDirection.remaining, 0);
    assert.doesNotMatch(prompt, /TEMPORARY SCENE DIRECTION|Knock/);
    assert.match(prompt, /Mood: 70%/);
    assert.ok(prompt.endsWith('[END SCENE DIRECTOR]'));
    assert.equal(f.prompts.at(-1)[1], prompt);
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
