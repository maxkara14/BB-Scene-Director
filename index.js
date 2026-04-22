import {
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_roles,
    extension_prompt_types,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    createCategoryRecord,
    createDirective as createDirectiveCore,
    createDefaultExpandedCategories,
    createPresetItemFromDirective,
    dedupePresetItems,
    getDefaultCategories,
    getFallbackCategoryId as getFallbackCategoryIdCore,
    guessDirectiveCategory as guessDirectiveCategoryCore,
    makeId,
    clamp,
    normalizeCategories as normalizeCategoriesCore,
    normalizeCategoryId as normalizeCategoryIdCore,
    normalizeDirectives as normalizeDirectivesCore,
    normalizeExpandedCategories as normalizeExpandedCategoriesCore,
    normalizePreset as normalizePresetCore,
    normalizePresetItem as normalizePresetItemCore,
    normalizePresets as normalizePresetsCore,
    snapDirectiveValue,
} from './preset-model.js';
import { createPresetManager } from './preset-manager.js';
import { createPresetTransferController } from './preset-transfer.js';
import { createMasterPresetParser } from './master-preset-parser.js';
import { createMasterPromptBuilder } from './master-prompts.js';
import { createMasterWorkflow } from './master-workflow.js';
import { createSceneDirectorUiController } from './director-ui.js';

const MODULE_NAME = 'BB-Scene-Director';
const SCHEMA_VERSION = 7;
const DEFAULT_MASTER_MAX_TOKENS = 1200;
const DEFAULT_MASTER_TEMPERATURE = 0.35;
const MASTER_REQUEST_TIMEOUT_MS = 90000;
const MASTER_STATUS_TIMEOUT_MS = 30000;
const MASTER_STRUCTURED_MIN_TOKENS = 2200;
const MASTER_STRUCTURED_MIN_TEMPERATURE = 0.45;
const MASTER_MIN_DIRECTIVE_COUNT = 5;
const MASTER_MIN_CATEGORY_COUNT = 3;
const MASTER_GENERATION_MAX_ATTEMPTS = 2;

const state = {
    promptUpdateRaf: null,
    masterChecking: false,
    masterGenerating: false,
    masterAbortController: null,
    revealDirectiveId: null,
};
let uiController = null;

initializeSettings();
window.bbGetSceneDirectorPrompt = getDirectorPromptText;

function initializeSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = createDefaultSettings();
        saveSettingsDebounced();
        return;
    }

    const settings = extension_settings[MODULE_NAME];
    const previousSchemaVersion = Number(settings.schemaVersion) || 0;
    let dirty = false;

    if (!Array.isArray(settings.directives)) {
        settings.directives = [];
        dirty = true;
    }

    if (!Array.isArray(settings.presets)) {
        settings.presets = [];
        dirty = true;
    }

    if (typeof settings.useMacro !== 'boolean') {
        settings.useMacro = false;
        dirty = true;
    }

    if (typeof settings.hideInactive !== 'boolean') {
        settings.hideInactive = false;
        dirty = true;
    }

    if (typeof settings.previewExpanded !== 'boolean') {
        settings.previewExpanded = false;
        dirty = true;
    }

    if (typeof settings.lastActivePreset === 'undefined') {
        settings.lastActivePreset = null;
        dirty = true;
    }

    if (!settings.v2PercentageMigrated) {
        settings.directives.forEach((directive) => {
            if (typeof directive?.value === 'number' && directive.value <= 10) {
                directive.value *= 10;
            }
        });

        settings.presets.forEach((preset) => {
            const collections = [];
            if (Array.isArray(preset?.smartStyles)) collections.push(preset.smartStyles);
            if (Array.isArray(preset?.directives)) collections.push(preset.directives);
            if (Array.isArray(preset?.items)) collections.push(preset.items);

            collections.forEach((collection) => {
                collection.forEach((item) => {
                    if (typeof item?.value === 'number' && item.value <= 10) {
                        item.value *= 10;
                    }
                });
            });
        });

        settings.v2PercentageMigrated = true;
        dirty = true;
    }

    const normalizedDirectives = normalizeDirectives(settings.directives);
    settings.directives = normalizedDirectives.length
        ? normalizedDirectives
        : createDefaultSettings().directives;
    dirty = true;

    settings.presets = normalizePresets(settings.presets, settings.directives);
    dirty = true;

    if (previousSchemaVersion > 0 && previousSchemaVersion < 7) {
        dirty = migrateLegacyCurrentDraft(settings) || dirty;
    }

    settings.categories = normalizeCategories(settings.categories, settings.directives, []);
    dirty = true;

    settings.expandedCategories = normalizeExpandedCategories(settings.expandedCategories, settings.categories);
    dirty = true;

    settings.masterPreset = normalizeMasterPreset(settings.masterPreset);
    dirty = true;

    if (
        settings.lastActivePreset !== null
        && (!Number.isInteger(settings.lastActivePreset) || settings.lastActivePreset < 0 || settings.lastActivePreset >= settings.presets.length)
    ) {
        settings.lastActivePreset = null;
        dirty = true;
    }

    if (settings.schemaVersion !== SCHEMA_VERSION) {
        settings.schemaVersion = SCHEMA_VERSION;
        dirty = true;
    }

    if (dirty) {
        saveSettingsDebounced();
    }
}

function createDefaultMasterPreset() {
    return {
        url: '',
        apiKey: '',
        model: '',
        availableModels: [],
        statusLevel: 'idle',
        statusText: 'Подключение ещё не проверялось.',
        lastPresetName: '',
        maxTokens: DEFAULT_MASTER_MAX_TOKENS,
        temperature: DEFAULT_MASTER_TEMPERATURE,
    };
}

function getCategories() {
    const settings = extension_settings[MODULE_NAME];
    if (settings && Array.isArray(settings.categories) && settings.categories.length) {
        return settings.categories;
    }

    return getDefaultCategories();
}

function getFallbackCategoryId(categories = getCategories()) {
    return getFallbackCategoryIdCore(categories);
}

function normalizeCategories(rawCategories, directives = [], presets = []) {
    return normalizeCategoriesCore(rawCategories, directives, presets, getCategories());
}

function createDefaultSettings() {
    return {
        schemaVersion: SCHEMA_VERSION,
        categories: getDefaultCategories(),
        directives: [],
        presets: [],
        useMacro: false,
        hideInactive: false,
        previewExpanded: false,
        expandedCategories: createDefaultExpandedCategories(),
        lastActivePreset: null,
        v2PercentageMigrated: true,
        masterPreset: createDefaultMasterPreset(),
    };
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function normalizeBaseUrl(value) {
    return String(value || '')
        .trim()
        .replace(/\/+(chat\/completions|completions|models)\/?$/i, '')
        .replace(/\/+$/, '');
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeCategoryId(value, categories = getCategories()) {
    return normalizeCategoryIdCore(value, categories);
}

function guessDirectiveCategory(name, categories = getCategories()) {
    return guessDirectiveCategoryCore(name, categories);
}

function createDirective(raw = {}, categories = getCategories()) {
    return createDirectiveCore(raw, categories);
}

function normalizeDirectives(rawDirectives) {
    return normalizeDirectivesCore(rawDirectives, getCategories());
}

function normalizeExpandedCategories(raw, categories = getCategories()) {
    return normalizeExpandedCategoriesCore(raw, categories);
}

function normalizePresetItem(raw, directivesByName = new Map(), categories = getCategories()) {
    return normalizePresetItemCore(raw, directivesByName, categories);
}

const masterPresetParser = createMasterPresetParser({
    createCategoryRecord,
    dedupePresetItems,
    getCategories,
    getDirectives: () => getSettings().directives,
    masterMinimumCategoryCount: MASTER_MIN_CATEGORY_COUNT,
    masterMinimumDirectiveCount: MASTER_MIN_DIRECTIVE_COUNT,
    normalizeCategories,
    normalizeCategoryId,
    normalizePresetItem,
});

const masterPromptBuilder = createMasterPromptBuilder({
    getCategories,
});

const presetTransfer = createPresetTransferController({
    dedupePresetItems,
    getCategories,
    getCurrentDraftItems: () => presetManager.captureCurrentPresetItems(),
    getSelectedPresetIndex,
    getSettings,
    getUniquePresetName,
    makeId,
    normalizeCategories,
    normalizePreset,
    normalizePresetItem,
    notify,
    renderPresetsDropdown,
    saveSettingsDebounced,
    setSelectedPresetIndex: (index) => {
        $('#bb-dir-preset-select').val(String(index));
    },
});

const presetManager = createPresetManager({
    applyExpandedCategoriesFromItems,
    confirmAction,
    createDirective,
    createPresetItemFromDirective,
    createPresetRecord: (...args) => presetTransfer.createPresetRecord(...args),
    flashButton,
    getCategories,
    getSelectedPresetIndex,
    getSettings,
    getUniquePresetName,
    makeId,
    normalizeCategories,
    normalizeCategoryId,
    normalizeExpandedCategories,
    normalizePresetItem,
    notify,
    promptText,
    renderDirectorHud,
    renderPresetsDropdown,
    saveSettingsDebounced,
    setSelectedPresetIndex: (index) => {
        $('#bb-dir-preset-select').val(String(index));
    },
    updateDirectorPrompt,
});

const masterWorkflow = createMasterWorkflow({
    abortMasterGeneration,
    constants: {
        DEFAULT_MASTER_MAX_TOKENS,
        DEFAULT_MASTER_TEMPERATURE,
        MASTER_GENERATION_MAX_ATTEMPTS,
        MASTER_REQUEST_TIMEOUT_MS,
        MASTER_STATUS_TIMEOUT_MS,
        MASTER_STRUCTURED_MIN_TEMPERATURE,
        MASTER_STRUCTURED_MIN_TOKENS,
    },
    getContext: () => SillyTavern.getContext(),
    getMasterSettings: () => getSettings().masterPreset,
    masterPresetParser,
    masterPromptBuilder,
    normalizeBaseUrl,
    notify,
    presetManager,
    renderDirectorHud,
    renderMasterControls,
    renderPresetsDropdown,
    saveSettingsDebounced,
    state,
    updateDirectorPrompt,
});

uiController = createSceneDirectorUiController({
    createCategoryRecord,
    createDirective,
    ensureCategoriesExist,
    ensureCategoryExpansionState,
    escapeHtml,
    getCategories,
    getContext: () => SillyTavern.getContext(),
    getIntensityLabel,
    getSettings,
    groupDirectivesByCategory,
    masterWorkflow,
    normalizeBaseUrl,
    normalizeCategoryId,
    normalizeExpandedCategories,
    notify,
    presetManager,
    presetTransfer,
    promptText,
    saveSettingsDebounced,
    schedulePromptUpdate,
    snapDirectiveValue,
    state,
    updateDirectorPrompt,
});

function normalizePreset(rawPreset, directives) {
    return normalizePresetCore(rawPreset, directives, getCategories());
}

function normalizePresets(rawPresets, directives) {
    return normalizePresetsCore(rawPresets, directives, getCategories());
}

function normalizeMasterPreset(raw) {
    const defaults = createDefaultMasterPreset();
    const master = raw && typeof raw === 'object' ? raw : {};

    return {
        url: normalizeBaseUrl(master.url),
        apiKey: typeof master.apiKey === 'string' ? master.apiKey : '',
        model: typeof master.model === 'string' ? master.model.trim() : '',
        availableModels: Array.isArray(master.availableModels)
            ? [...new Set(master.availableModels.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 200)
            : [],
        statusLevel: ['idle', 'success', 'error'].includes(master.statusLevel) ? master.statusLevel : defaults.statusLevel,
        statusText: typeof master.statusText === 'string' && master.statusText.trim()
            ? master.statusText
            : defaults.statusText,
        lastPresetName: typeof master.lastPresetName === 'string' ? master.lastPresetName : '',
        maxTokens: clamp(Math.round(Number(master.maxTokens) || defaults.maxTokens), 120, 4000),
        temperature: clamp(Number((Number(master.temperature) || defaults.temperature).toFixed(2)), 0, 2),
    };
}

function ensureCategoriesExist(categorySources = []) {
    const settings = getSettings();
    const categories = Array.isArray(settings.categories) ? [...settings.categories] : getDefaultCategories();
    const seen = new Set(categories.map((category) => category.id));
    let changed = false;

    categorySources.forEach((source) => {
        if (!source) {
            return;
        }

        if (typeof source === 'string' && !source.trim()) {
            return;
        }

        if (typeof source === 'object' && !String(source.id || source.label || source.name || '').trim()) {
            return;
        }

        const category = source && typeof source === 'object'
            ? createCategoryRecord(source, categories.length)
            : createCategoryRecord({ id: source }, categories.length);

        if (!category.id || seen.has(category.id)) {
            return;
        }

        categories.push(category);
        seen.add(category.id);
        changed = true;
    });

    if (!changed) {
        return false;
    }

    settings.categories = normalizeCategories(categories, settings.directives, []);
    settings.expandedCategories = normalizeExpandedCategories(settings.expandedCategories, settings.categories);
    return true;
}

function ensureCategoryExpansionState(categoryId, expanded) {
    const settings = getSettings();
    settings.expandedCategories = normalizeExpandedCategories(settings.expandedCategories, settings.categories);
    settings.expandedCategories[normalizeCategoryId(categoryId, settings.categories)] = Boolean(expanded);
}

function applyExpandedCategoriesFromItems(items) {
    ensureCategoriesExist(items.map((item) => ({ id: item?.category })));
    const expandedCategories = createDefaultExpandedCategories(getSettings().categories);

    items.forEach((rawItem) => {
        const item = normalizePresetItem(rawItem);
        if (!item || item.active === false) {
            return;
        }

        expandedCategories[item.category] = true;
    });

    getSettings().expandedCategories = expandedCategories;
}

function getCategoryMeta(categoryId) {
    const categories = getCategories();
    return categories.find((category) => category.id === normalizeCategoryId(categoryId, categories))
        || categories[categories.length - 1]
        || createCategoryRecord({ id: categoryId });
}

function getIntensityLabel(value) {
    if (value === 0) return 'ВЫКЛ';
    if (value <= 30) return 'НИЗКИЙ';
    if (value <= 65) return 'СРЕДНИЙ';
    if (value <= 85) return 'ВЫСОКИЙ';
    return 'МАКС';
}

function getIntensityPromptHint(value) {
    if (value === 0) return '(Off)';
    if (value <= 30) return '(Low)';
    if (value <= 65) return '(Medium)';
    if (value <= 85) return '(High)';
    return '(Max)';
}

function groupDirectivesByCategory(directives) {
    const categories = getCategories();
    const groups = new Map(categories.map((category) => [category.id, []]));

    directives.forEach((directive) => {
        const categoryId = normalizeCategoryId(directive.category, categories);
        if (!groups.has(categoryId)) {
            groups.set(categoryId, []);
        }
        groups.get(categoryId)?.push(directive);
    });

    return groups;
}

function getDirectorPromptText() {
    const activeDirectives = getSettings().directives.filter((directive) => directive.active);
    if (!activeDirectives.length) {
        return '';
    }

    const categories = getCategories();
    const groups = groupDirectivesByCategory(activeDirectives);
    const lines = [
        '[SCENE DIRECTOR: Treat the following preset as an active directing layer for the next reply.]',
        '[Use it as invisible scene control: shape tone, pacing, framing, intimacy, conflict pressure, descriptive emphasis, escalation, and scene movement.]',
        '[Do not list or mention these directives explicitly. Express them through wording, rhythm, focus, and scene choices while staying coherent and fully in-character.]',
        '[Higher values must have noticeably stronger influence. 0% means ignore that directive. If directives conflict, stronger values take priority.]',
    ];

    categories.forEach((category) => {
        const directives = groups.get(category.id) || [];
        if (!directives.length) {
            return;
        }

        lines.push('');
        lines.push(`[${category.promptLabel.toUpperCase()}]`);

        directives.forEach((directive) => {
            lines.push(`- ${directive.name}: ${directive.value}% ${getIntensityPromptHint(directive.value)}`);
        });
    });

    lines.push('');
    lines.push('[END SCENE DIRECTOR]');

    return lines.join('\n').trim();
}

function updateDirectorPrompt() {
    const promptText = getDirectorPromptText();
    const previewBox = $('#bb-dir-preview-text');

    if (previewBox.length) {
        previewBox.text(promptText || 'Нет активных директив. Промпт сейчас пустой.');
    }

    if (getSettings().useMacro) {
        setExtensionPrompt(
            'bb_scene_director',
            '',
            extension_prompt_types.IN_CHAT,
            1,
            false,
            extension_prompt_roles.SYSTEM,
        );
        return;
    }

    setExtensionPrompt(
        'bb_scene_director',
        promptText,
        extension_prompt_types.IN_CHAT,
        1,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function schedulePromptUpdate() {
    if (state.promptUpdateRaf !== null) {
        return;
    }

    state.promptUpdateRaf = requestAnimationFrame(() => {
        state.promptUpdateRaf = null;
        updateDirectorPrompt();
    });
}

function renderPresetsDropdown() {
    uiController?.renderPresetsDropdown();
}

function getSelectedPresetIndex() {
    const rawValue = $('#bb-dir-preset-select').val();
    if (rawValue === null || rawValue === '') {
        return null;
    }

    const parsed = Number.parseInt(String(rawValue), 10);
    return Number.isInteger(parsed) ? parsed : null;
}

function flashButton(button, cssClass = 'is-success') {
    const element = $(button);
    element.addClass(cssClass);
    setTimeout(() => element.removeClass(cssClass), 420);
}

async function promptText(message, defaultValue = '', popupOptions = {}) {
    const context = SillyTavern.getContext();

    if (context.callGenericPopup && context.POPUP_TYPE) {
        const result = await context.callGenericPopup(message, context.POPUP_TYPE.INPUT, defaultValue, popupOptions);
        if (result === false || result === null) {
            return null;
        }
        return String(result);
    }

    const result = window.prompt(String(message), defaultValue);
    return result === null ? null : String(result);
}

async function confirmAction(message, popupOptions = {}) {
    const context = SillyTavern.getContext();

    if (context.callGenericPopup && context.POPUP_TYPE) {
        const result = await context.callGenericPopup(message, context.POPUP_TYPE.CONFIRM, '', popupOptions);
        return Boolean(result);
    }

    return window.confirm(String(message));
}

function notify(level, message, title = 'BB Scene Director') {
    if (window.toastr && typeof window.toastr[level] === 'function') {
        window.toastr[level](message, title);
        return;
    }

    const method = level === 'error' ? 'error' : 'log';
    console[method](`[${title}] ${message}`);
}

function getUniquePresetName(baseName, presets = getSettings().presets) {
    const trimmedBase = String(baseName || '').trim() || 'Без названия';
    const existingNames = new Set((Array.isArray(presets) ? presets : []).map((preset) => String(preset?.name || '').trim()));
    if (!existingNames.has(trimmedBase)) {
        return trimmedBase;
    }

    let counter = 2;
    while (existingNames.has(`${trimmedBase} (${counter})`)) {
        counter += 1;
    }

    return `${trimmedBase} (${counter})`;
}

function migrateLegacyCurrentDraft(settings) {
    const currentDirectives = Array.isArray(settings.directives) ? settings.directives : [];
    const hasInactiveTail = currentDirectives.some((directive) => directive && directive.active === false);

    if (!hasInactiveTail || currentDirectives.length === 0) {
        return false;
    }

    const backupPreset = presetTransfer.createPresetRecord(
        getUniquePresetName('Миграция: старый черновик', settings.presets),
        currentDirectives.map((directive) => createPresetItemFromDirective(directive)),
        {
            generated: false,
            categories: normalizeCategories(settings.categories, currentDirectives, []),
            summary: 'Автоматический backup перед переходом на изолированный черновик.',
        },
    );

    settings.presets.push(backupPreset);
    settings.directives = currentDirectives.filter((directive) => directive.active);
    settings.categories = normalizeCategories([], settings.directives, []);
    settings.expandedCategories = normalizeExpandedCategories({}, settings.categories);
    settings.lastActivePreset = null;

    return true;
}

function renderDirectorHud() {
    uiController?.renderDirectorHud();
}

function abortMasterGeneration(reason = 'Отменено пользователем.') {
    if (state.masterAbortController && !state.masterAbortController.signal.aborted) {
        state.masterAbortController.abort(reason);
    }
}

function renderMasterControls() {
    uiController?.renderMasterControls();
}

function setupExtensionSettings() {
    uiController?.setupExtensionSettings();
}

function ensureDirectorHud() {
    uiController?.ensureDirectorHud();
}

function toggleHudVisibility() {
    uiController?.toggleHudVisibility();
}

function updateHudTopOffset() {
    uiController?.updateHudTopOffset();
}

jQuery(async () => {
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        const context = SillyTavern.getContext();

        if (context.registerMacro) {
            context.registerMacro('bb_scene', () => (getSettings().useMacro ? getDirectorPromptText() : ''));
        }

        eventSource.on(event_types.APP_READY, () => {
            setupExtensionSettings();
            ensureDirectorHud();
            renderPresetsDropdown();
            renderDirectorHud();
            renderMasterControls();
            updateHudTopOffset();
            toggleHudVisibility();

            window.addEventListener('resize', updateHudTopOffset, { passive: true });
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            updateHudTopOffset();
            toggleHudVisibility();
            renderMasterControls();
        });

        eventSource.on(event_types.GENERATE_AFTER_DATA, (generate_data) => {
            if (!getSettings().useMacro) {
                return;
            }

            if (!generate_data || !Array.isArray(generate_data.messages)) {
                return;
            }

            const promptText = getDirectorPromptText();
            for (const message of generate_data.messages) {
                if (message && typeof message.content === 'string' && message.content.includes('{{bb_scene}}')) {
                    message.content = message.content.replace(/\{\{bb_scene\}\}/g, promptText);
                }
            }
        });
    } catch (error) {
        console.error('[BB Scene Director] Ошибка:', error);
    }
});
