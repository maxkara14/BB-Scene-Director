import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../preset-model.js';
import { createMasterPresetParser } from '../master-preset-parser.js';
import { createSceneEditController } from '../scene-edit.js';
import { createFixture, loadWithHostMocks } from './helpers.mjs';

const editResponse = JSON.stringify({ changes: [{ op: 'update', id: 'original', directive: { name: 'Mood', value: 80, active: false, category: 'focus' } }] });

for (const mode of ['custom', 'main', 'profile']) {
    test(`${mode} new preset honors description opt-out even if the model ignores it`, async () => {
        for (const generateDescriptions of [false, true]) {
            const f = await setup({ mode, generateDescriptions });
            await f.workflow.generateMasterPreset('Horror');
            assert.equal(f.master.statusLevel, 'success');
            assert.ok(f.settings.directives.every(item => item.description === (generateDescriptions ? 'Generated description' : '')));
            assert.ok(f.settings.presets.at(-1).items.every(item => item.description === (generateDescriptions ? 'Generated description' : '')));
        }
    });
}

for (const mode of ['custom', 'main', 'profile']) {
    test(`${mode} scene editing previews a sparse result before applying, without replacing library presets`, async () => {
        const f = await setup({ mode, response: editResponse });
        f.confirm(false);
        await f.workflow.generateMasterPreset('Raise tension', { mode: 'edit', messageCount: 10 });
        assert.equal(f.settings.directives[0].value, 80);
        assert.equal(f.settings.directives[0].active, false);
        assert.equal(f.settings.presets.length, 1);
        assert.equal(f.confirmationCount(), 0);
        assert.deepEqual(f.events, ['show', 'hide', 'preview']);
        assert.equal(f.state.masterGenerating, false);
        f.draftState.undo();
        assert.equal(f.settings.directives[0].value, 30);
    });
}

for (const option of ['cancelPreview', 'changeDuringPreview', 'abortDuringPreview', 'changeDraft', 'ignoreAbort']) {
    test(`scene editing preserves user state on ${option}`, async () => {
        const f = await setup({ response: editResponse, [option]: true });
        await f.workflow.generateMasterPreset('Edit', { mode: 'edit' });
        assert.equal(f.settings.directives[0].value, ['changeDraft', 'changeDuringPreview'].includes(option) ? 95 : 30);
        assert.equal(f.settings.presets.length, 1);
        assert.equal(f.draftState.getStatus().canUndo, false);
    });
}

test('malformed edit response and an empty request cannot change the scene', async () => {
    const f = await setup({ response: '{"changes":[' });
    await f.workflow.generateMasterPreset('', { mode: 'edit' });
    assert.equal(f.calls.length, 0);
    await f.workflow.generateMasterPreset('Edit', { mode: 'edit' });
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.master.statusLevel, 'error');
    assert.ok(!f.events.includes('preview'));
});

async function setup(options = {}) {
    const f = createFixture();
    const master = {
        connectionMode: options.mode || 'custom', url: 'https://example.invalid/v1',
        apiKey: 'synthetic-key', model: 'custom-model', tavernProfileId: 'profile',
        allowMainFallback: options.allowFallback === true,
        generateDescriptions: options.generateDescriptions !== false,
    };
    const state = {};
    const calls = [];
    const events = [];
    const generated = options.response ?? JSON.stringify({
        presetName: 'Generated',
        categories: f.settings.categories.map((category, index) => ({
            ...category,
            directives: [1, 2].map((number) => ({ name: `Direction ${index}-${number}`, description: 'Generated description', value: 70, active: true })),
        })),
    });
    const connections = await loadWithHostMocks('master-connection.js', {
        '../../../../script.js': { getRequestHeaders: () => ({}) },
        '../../shared.js': { ConnectionManagerRequestService: {
            getSupportedProfiles: () => [{ id: 'profile', name: 'Profile', model: 'profile-model' }],
            validateProfile: () => ({ selected: 'openai', source: 'openai' }),
            sendRequest: async (...args) => { calls.push({ type: 'profile', args }); return { content: generated }; },
        } },
        '../../../openai.js': {
            chat_completion_sources: { CUSTOM: 'custom' },
            oai_settings: { chat_completion_source: 'openai' },
            getChatCompletionModel: () => 'main-model',
            createGenerationParameters: async () => ({ generate_data: { max_tokens: 1234 } }),
        },
    }, {
        AbortController, structuredClone, window: { setTimeout, clearTimeout },
        fetch: async (url, request) => {
            calls.push({ type: 'custom', url, body: JSON.parse(request.body) });
            if (options.changeDraft) f.settings.directives[0].value = 95;
            if (options.abort) {
                state.masterAbortController.abort('Отменено пользователем.');
                throw new TypeError('invalid_argument');
            }
            if (options.ignoreAbort) state.masterAbortController.abort('Чат изменился.');
            if (options.failCustom) throw new TypeError('Failed to fetch');
            return { ok: true, json: async () => ({ choices: [{ message: { content: options.malformed ? 'not a preset' : generated } }] }) };
        },
    });
    const { createMasterWorkflow } = await loadWithHostMocks('master-workflow.js', { './master-connection.js': connections }, {
        console: { warn() {}, error() {} },
    });
    const workflow = createMasterWorkflow({
        sceneEditor: createSceneEditController({
            getSettings: () => f.settings, getContext: () => ({ chat: [{ name: 'Actor', mes: 'Recent event' }] }), draftState: f.draftState,
            preview: async (_, changes) => {
                events.push('preview');
                assert.equal(events[events.length - 2], 'hide');
                if (options.changeDuringPreview) f.settings.directives[0].value = 95;
                if (options.abortDuringPreview) state.masterAbortController.abort('Cancelled');
                return options.cancelPreview ? [] : changes;
            },
        }),
        draftState: f.draftState,
        abortMasterGeneration: (reason) => state.masterAbortController?.abort(reason),
        constants: {
            DEFAULT_MASTER_MAX_TOKENS: 5000, DEFAULT_MASTER_TEMPERATURE: 0.35,
            MASTER_GENERATION_MAX_ATTEMPTS: 2, MASTER_REQUEST_TIMEOUT_MS: 90000,
            MASTER_STATUS_TIMEOUT_MS: 30000, MASTER_STRUCTURED_MIN_TEMPERATURE: 0.45,
            MASTER_STRUCTURED_MIN_TOKENS: 5000,
        },
        getContext: () => ({ loader: { show: () => { events.push('show'); return { hide: async () => events.push('hide') }; } }, ChatCompletionService: {
            processRequest: async (payload) => { calls.push({ type: 'main', payload }); return { content: generated }; },
        } }),
        getMasterSettings: () => master,
        masterPresetParser: createMasterPresetParser({
            ...model, getCategories: () => f.settings.categories, getDirectives: () => f.settings.directives,
            masterMinimumCategoryCount: 3, masterMinimumDirectiveCount: 5,
        }),
        masterPromptBuilder: { getResolvedMasterContext: () => 'Synthetic character', buildMasterMessages: () => ({ sourceText: 'Synthetic character', systemPrompt: 'System', userPrompt: 'User' }) },
        normalizeBaseUrl: (url) => String(url || '').replace(/\/+$/, ''),
        notify: (...args) => f.messages.push(args), presetManager: f.manager,
        renderDirectorHud() {}, renderMasterControls() {}, renderPresetsDropdown() {},
        saveSettingsDebounced() {}, state, updateDirectorPrompt() {},
    });
    return { ...f, master, state, calls, workflow, events };
}

test('custom failure stays on selected connection by default and keeps the draft/library', async () => {
    const f = await setup({ failCustom: true });
    await f.workflow.generateMasterPreset();
    assert.deepEqual(f.calls.map((call) => call.type), ['custom']);
    assert.equal(f.settings.presets.length, 1);
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.master.statusLevel, 'error');
    assert.equal(f.state.masterGenerating, false);
    assert.equal(f.state.masterAbortController, null);
});

test('explicit fallback warns, uses main, parses result, and applies an undoable preset', async () => {
    const f = await setup({ failCustom: true, allowFallback: true });
    await f.workflow.generateMasterPreset();
    assert.deepEqual(f.calls.map((call) => call.type), ['custom', 'main']);
    assert.equal(f.calls[1].payload.model, 'main-model');
    assert.ok(f.messages.some(([level]) => level === 'warning'));
    assert.equal(f.settings.directives.length, 6);
    assert.equal(f.draftState.getStatus().dirty, false);
    f.draftState.undo();
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.settings.lastActivePreset, 0);
    assert.equal(f.settings.presets.length, 2);
});

for (const mode of ['custom', 'main', 'profile']) {
    test(`${mode} successful generation uses only the selected route`, async () => {
        const f = await setup({ mode });
        await f.workflow.generateMasterPreset();
        assert.deepEqual(f.calls.map((call) => call.type), [mode]);
        assert.equal(f.settings.presets.length, 2);
        assert.equal(f.settings.directives.length, 6);
        assert.equal(f.master.statusLevel, 'success');
    });
}

test('cancellation with a generic fetch error never falls back or applies a result', async () => {
    const f = await setup({ abort: true, allowFallback: true });
    await f.workflow.generateMasterPreset();
    assert.deepEqual(f.calls.map((call) => call.type), ['custom']);
    assert.equal(f.settings.presets.length, 1);
    assert.equal(f.master.statusLevel, 'idle');
});

test('a late successful response after cancellation cannot create or apply a preset', async () => {
    const f = await setup({ ignoreAbort: true });
    await f.workflow.generateMasterPreset();
    assert.equal(f.settings.presets.length, 1);
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.master.statusLevel, 'idle');
});

test('edits made during generation survive; generated result is saved without becoming active', async () => {
    const f = await setup({ changeDraft: true });
    await f.workflow.generateMasterPreset();
    assert.equal(f.settings.directives[0].value, 95);
    assert.equal(f.settings.lastActivePreset, 0);
    assert.equal(f.settings.presets.length, 2);
    assert.ok(f.messages.some(([, message]) => message.includes('результат не применён')));
});

test('declining draft replacement prevents the request entirely', async () => {
    const f = await setup();
    f.settings.directives[0].value = 90;
    f.confirm(false);
    await f.workflow.generateMasterPreset();
    assert.equal(f.calls.length, 0);
    assert.equal(f.settings.directives[0].value, 90);
});

test('malformed generation cannot replace the scene or create a library preset', async () => {
    const f = await setup({ malformed: true });
    await f.workflow.generateMasterPreset();
    assert.equal(f.settings.directives[0].value, 30);
    assert.equal(f.settings.presets.length, 1);
    assert.equal(f.master.statusLevel, 'error');
});
