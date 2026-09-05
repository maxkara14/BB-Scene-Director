import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../preset-model.js';
import { createMasterPresetParser } from '../master-preset-parser.js';
import { createFixture, loadWithHostMocks } from './helpers.mjs';

async function setup(options = {}) {
    const f = createFixture();
    const master = {
        connectionMode: options.mode || 'custom', url: 'https://example.invalid/v1',
        apiKey: 'synthetic-key', model: 'custom-model', tavernProfileId: 'profile',
        allowMainFallback: options.allowFallback === true,
    };
    const state = {};
    const calls = [];
    const generated = JSON.stringify({
        presetName: 'Generated',
        categories: f.settings.categories.map((category, index) => ({
            ...category,
            directives: [1, 2].map((number) => ({ name: `Direction ${index}-${number}`, value: 70, active: true })),
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
        draftState: f.draftState,
        abortMasterGeneration: (reason) => state.masterAbortController?.abort(reason),
        constants: {
            DEFAULT_MASTER_MAX_TOKENS: 5000, DEFAULT_MASTER_TEMPERATURE: 0.35,
            MASTER_GENERATION_MAX_ATTEMPTS: 2, MASTER_REQUEST_TIMEOUT_MS: 90000,
            MASTER_STATUS_TIMEOUT_MS: 30000, MASTER_STRUCTURED_MIN_TEMPERATURE: 0.45,
            MASTER_STRUCTURED_MIN_TOKENS: 5000,
        },
        getContext: () => ({ ChatCompletionService: {
            processRequest: async (payload) => { calls.push({ type: 'main', payload }); return { content: generated }; },
        } }),
        getMasterSettings: () => master,
        masterPresetParser: createMasterPresetParser({
            ...model, getCategories: () => f.settings.categories, getDirectives: () => f.settings.directives,
            masterMinimumCategoryCount: 3, masterMinimumDirectiveCount: 5,
        }),
        masterPromptBuilder: { buildMasterMessages: () => ({ sourceText: 'Synthetic character', systemPrompt: 'System', userPrompt: 'User' }) },
        normalizeBaseUrl: (url) => String(url || '').replace(/\/+$/, ''),
        notify: (...args) => f.messages.push(args), presetManager: f.manager,
        renderDirectorHud() {}, renderMasterControls() {}, renderPresetsDropdown() {},
        saveSettingsDebounced() {}, state, updateDirectorPrompt() {},
    });
    return { ...f, master, state, calls, workflow };
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
