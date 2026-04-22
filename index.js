import {
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
    extension_prompt_roles,
    extension_prompt_types,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { chat_completion_sources } from '../../../openai.js';
import {
    PRESET_FILE_FORMAT,
    PRESET_FILE_VERSION,
    createPresetFilePayload,
    parsePresetImportText,
    sanitizePresetFilename,
    stringifyPresetFile,
} from './preset-storage.js';

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

const DEFAULT_CATEGORY_TEMPLATES = [
    {
        id: 'focus',
        label: 'Фокус',
        promptLabel: 'Focus',
        hint: 'Эмоции, атмосфера, POV, близость, тон сцены',
    },
    {
        id: 'dynamics',
        label: 'Динамика',
        promptLabel: 'Dynamics',
        hint: 'Темп, действие, конфликт, энергия, напряжение',
    },
    {
        id: 'plot',
        label: 'Сюжет',
        promptLabel: 'Plot',
        hint: 'Движение истории, ставки, интрига, прогресс',
    },
];
const LEGACY_EXTRA_CATEGORY_TEMPLATE = {
    id: 'extras',
    label: 'Ещё',
    promptLabel: 'Extras',
    hint: 'Жесткость, сюрреализм, юмор, твисты, спец-приёмы',
};
const BUILTIN_CATEGORY_TEMPLATES = [...DEFAULT_CATEGORY_TEMPLATES, LEGACY_EXTRA_CATEGORY_TEMPLATE];
const BUILTIN_CATEGORY_TEMPLATE_MAP = new Map(BUILTIN_CATEGORY_TEMPLATES.map((category) => [category.id, category]));
const BUILTIN_CATEGORY_ALIASES = {
    focus: 'focus',
    tone: 'focus',
    mood: 'focus',
    atmosphere: 'focus',
    emotion: 'focus',
    emotions: 'focus',
    drama: 'focus',
    romance: 'focus',
    intimacy: 'focus',
    dynamics: 'dynamics',
    dynamic: 'dynamics',
    pace: 'dynamics',
    pacing: 'dynamics',
    action: 'dynamics',
    conflict: 'dynamics',
    plot: 'plot',
    story: 'plot',
    scenario: 'plot',
    mystery: 'plot',
    extras: 'extras',
    extra: 'extras',
    gore: 'extras',
    surreal: 'extras',
    comedy: 'extras',
    'фокус': 'focus',
    'эмоции': 'focus',
    'атмосфера': 'focus',
    'драма': 'focus',
    'динамика': 'dynamics',
    'экшен': 'dynamics',
    'темп': 'dynamics',
    'сюжет': 'plot',
    'история': 'plot',
    'сценарий': 'plot',
    'ещё': 'extras',
    'еще': 'extras',
    'дополнительно': 'extras',
    'жесткость': 'extras',
    'жёсткость': 'extras',
    'юмор': 'extras',
};

const MASTER_CONTEXT_TEMPLATE = [
    'Имя персонажа: {{char}}',
    'Описание персонажа: {{description}}',
    'Характер персонажа: {{personality}}',
    'Сценарий: {{scenario}}',
    'Имя пользователя: {{user}}',
    'Персона пользователя: {{persona}}',
    'Название группы: {{group}}',
].join('\n');

function buildMasterPresetJsonSchema(categories = getCategories()) {
    return {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            presetName: {
                type: 'string',
                minLength: 1,
                maxLength: 80,
            },
            categories: {
                type: 'array',
                minItems: 1,
                maxItems: 8,
                items: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 40,
                        },
                        label: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 60,
                        },
                        promptLabel: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 60,
                        },
                        hint: {
                            type: 'string',
                            minLength: 0,
                            maxLength: 120,
                        },
                        directives: {
                            type: 'array',
                            minItems: 1,
                            maxItems: 4,
                            items: {
                                type: 'object',
                                properties: {
                                    name: {
                                        type: 'string',
                                        minLength: 1,
                                        maxLength: 60,
                                    },
                                    value: {
                                        type: 'integer',
                                        minimum: 0,
                                        maximum: 100,
                                        multipleOf: 5,
                                    },
                                    active: {
                                        type: 'boolean',
                                    },
                                },
                                required: ['name', 'value', 'active'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['id', 'label', 'promptLabel', 'hint', 'directives'],
                    additionalProperties: false,
                },
            },
        },
        required: ['presetName', 'categories'],
        additionalProperties: false,
    };
}

const state = {
    promptUpdateRaf: null,
    masterChecking: false,
    masterGenerating: false,
    masterAbortController: null,
    revealDirectiveId: null,
};

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

function createCategoryFromTemplate(template) {
    return {
        id: template.id,
        label: template.label,
        promptLabel: template.promptLabel,
        hint: template.hint,
    };
}

function getDefaultCategories() {
    return DEFAULT_CATEGORY_TEMPLATES.map((category) => createCategoryFromTemplate(category));
}

function getCategories() {
    const settings = extension_settings[MODULE_NAME];
    if (settings && Array.isArray(settings.categories) && settings.categories.length) {
        return settings.categories;
    }

    return getDefaultCategories();
}

function getFallbackCategoryId(categories = getCategories()) {
    return categories[0]?.id || DEFAULT_CATEGORY_TEMPLATES[0].id;
}

function slugifyCategoryId(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }

    if (BUILTIN_CATEGORY_ALIASES[raw]) {
        return BUILTIN_CATEGORY_ALIASES[raw];
    }

    return raw
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\u0400-\u04ff]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 40);
}

function humanizeCategoryId(categoryId) {
    const raw = String(categoryId || '').trim();
    if (!raw) {
        return 'Новая категория';
    }

    const withSpaces = raw.replace(/[-_]+/g, ' ').trim();
    return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

function createCategoryRecord(raw = {}, index = 0) {
    const sourceId = String(raw.id || raw.key || '').trim();
    const sourceLabel = String(raw.label || raw.name || '').trim();
    const normalizedId = slugifyCategoryId(sourceId || sourceLabel) || `category-${index + 1}`;
    const template = BUILTIN_CATEGORY_TEMPLATE_MAP.get(normalizedId);
    const label = sourceLabel || template?.label || humanizeCategoryId(normalizedId);
    const promptLabel = String(raw.promptLabel || '').trim() || template?.promptLabel || label;
    const hint = String(raw.hint || '').trim() || template?.hint || '';

    return {
        id: normalizedId,
        label,
        promptLabel,
        hint,
    };
}

function collectReferencedCategoryIds(directives = [], presets = []) {
    const ids = new Set();
    const addValue = (value) => {
        if (typeof value !== 'string' || !value.trim()) {
            return;
        }
        const normalized = normalizeCategoryId(value, []);
        if (normalized) {
            ids.add(normalized);
        }
    };

    directives.forEach((directive) => addValue(directive?.category));

    presets.forEach((preset) => {
        const items = Array.isArray(preset?.items)
            ? preset.items
            : Array.isArray(preset?.directives)
                ? preset.directives
                : Array.isArray(preset?.smartStyles)
                    ? preset.smartStyles
                    : [];

        items.forEach((item) => addValue(item?.category));
    });

    return ids;
}

function normalizeCategories(rawCategories, directives = [], presets = []) {
    const source = Array.isArray(rawCategories) ? rawCategories : [];
    const normalized = [];
    const seen = new Set();

    const pushCategory = (rawCategory) => {
        const category = createCategoryRecord(rawCategory, normalized.length);
        if (!category.id || seen.has(category.id)) {
            return;
        }

        seen.add(category.id);
        normalized.push(category);
    };

    if (source.length) {
        source.forEach(pushCategory);
    } else {
        getDefaultCategories().forEach(pushCategory);
    }

    const referencedIds = collectReferencedCategoryIds(directives, presets);
    if (!source.length && referencedIds.has('extras')) {
        pushCategory(LEGACY_EXTRA_CATEGORY_TEMPLATE);
    }

    referencedIds.forEach((categoryId) => {
        if (seen.has(categoryId)) {
            return;
        }

        pushCategory(BUILTIN_CATEGORY_TEMPLATE_MAP.get(categoryId) || { id: categoryId });
    });

    return normalized.length ? normalized : getDefaultCategories();
}

function createDefaultExpandedCategories(categories = getDefaultCategories()) {
    return Object.fromEntries(categories.map((category) => [category.id, false]));
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

function makeId(prefix = 'bbdir') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function snapDirectiveValue(value) {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
        return 50;
    }

    return clamp(Math.round(numeric / 5) * 5, 0, 100);
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
    const ids = new Set((Array.isArray(categories) ? categories : []).map((category) => category.id));

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return getFallbackCategoryId(categories);
        }

        if (ids.has(trimmed)) {
            return trimmed;
        }

        const normalized = slugifyCategoryId(trimmed);
        if (ids.has(normalized)) {
            return normalized;
        }

        if (normalized) {
            return normalized;
        }
    }

    return getFallbackCategoryId(categories);
}

function guessDirectiveCategory(name) {
    const normalized = String(name || '').trim().toLowerCase();

    if (!normalized) {
        return getFallbackCategoryId();
    }

    if (/(action|dynamic|pace|pacing|chaos|conflict|tempo|adrenaline|экшен|динамик|темп)/i.test(normalized)) {
        return 'dynamics';
    }

    if (/(plot|story|scenario|mystery|stakes|twist|сюжет|истори|сценар)/i.test(normalized)) {
        return 'plot';
    }

    if (/(emotion|drama|romance|focus|mood|tone|pov|atmosphere|intimacy|эмоц|драм|роман|фокус|атмосфер)/i.test(normalized)) {
        return 'focus';
    }

    return getFallbackCategoryId();
}

function createDirective(raw = {}) {
    return {
        id: String(raw.id || makeId('dir')),
        name: String(raw.name || 'Новая директива').trim() || 'Новая директива',
        value: snapDirectiveValue(raw.value),
        active: Boolean(raw.active),
        category: normalizeCategoryId(raw.category || guessDirectiveCategory(raw.name)),
    };
}

function normalizeDirectives(rawDirectives) {
    const directives = [];
    const seenIds = new Set();

    rawDirectives.forEach((directive) => {
        if (!directive || typeof directive !== 'object') {
            return;
        }

        const normalized = createDirective(directive);
        if (seenIds.has(normalized.id)) {
            normalized.id = makeId('dir');
        }

        seenIds.add(normalized.id);
        directives.push(normalized);
    });

    return directives;
}

function normalizeExpandedCategories(raw, categories = getCategories()) {
    const defaults = createDefaultExpandedCategories(categories);
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalized = { ...defaults };

    Object.keys(source).forEach((categoryId) => {
        const normalizedId = normalizeCategoryId(categoryId, categories);
        if (normalizedId) {
            normalized[normalizedId] = Boolean(source[categoryId]);
        }
    });

    return normalized;
}

function createPresetItemFromDirective(directive) {
    return {
        directiveId: String(directive.id),
        name: directive.name,
        category: directive.category,
        value: directive.value,
        active: directive.active !== false,
    };
}

function normalizePresetItem(raw, directivesByName = new Map(), categories = getCategories()) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const name = String(raw.name || '').trim();
    if (!name) {
        return null;
    }

    const directiveByName = directivesByName.get(name.toLowerCase());
    const directiveId = raw.directiveId || raw.id || directiveByName?.id || '';

    return {
        directiveId: directiveId ? String(directiveId) : '',
        name,
        category: normalizeCategoryId(raw.category || directiveByName?.category || guessDirectiveCategory(name), categories),
        value: snapDirectiveValue(raw.value),
        active: raw.active !== false,
    };
}

function dedupePresetItems(items) {
    const unique = [];
    const seen = new Set();

    items.forEach((item) => {
        if (!item) {
            return;
        }

        const key = item.directiveId || `${item.category}:${item.name.toLowerCase()}`;
        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        unique.push(item);
    });

    return unique;
}

function normalizePreset(rawPreset, directives) {
    if (!rawPreset || typeof rawPreset !== 'object') {
        return null;
    }

    const directivesByName = new Map(directives.map((directive) => [directive.name.toLowerCase(), directive]));
    let sourceItems = [];

    if (Array.isArray(rawPreset.items)) {
        sourceItems = rawPreset.items;
    } else if (Array.isArray(rawPreset.smartStyles)) {
        sourceItems = rawPreset.smartStyles.map((item) => ({ ...item, active: true }));
    } else if (Array.isArray(rawPreset.directives)) {
        sourceItems = rawPreset.directives;
    }

    const sourceCategories = normalizeCategories(rawPreset.categories, sourceItems, []);

    const items = dedupePresetItems(
        sourceItems
            .map((item) => normalizePresetItem(item, directivesByName, sourceCategories))
            .filter(Boolean),
    );

    return {
        id: String(rawPreset.id || makeId('preset')),
        name: String(rawPreset.name || 'Без названия').trim() || 'Без названия',
        items,
        categories: normalizeCategories(sourceCategories, items, []),
        storage: {
            format: typeof rawPreset?.storage?.format === 'string' ? rawPreset.storage.format : PRESET_FILE_FORMAT,
            version: Number.isInteger(rawPreset?.storage?.version) ? rawPreset.storage.version : PRESET_FILE_VERSION,
        },
        meta: rawPreset.meta && typeof rawPreset.meta === 'object'
            ? {
                generated: Boolean(rawPreset.meta.generated),
                summary: String(rawPreset.meta.summary || ''),
            }
            : {
                generated: false,
                summary: '',
            },
    };
}

function normalizePresets(rawPresets, directives) {
    const presets = [];
    const seenIds = new Set();

    rawPresets.forEach((preset) => {
        const normalized = normalizePreset(preset, directives);
        if (!normalized) {
            return;
        }

        if (seenIds.has(normalized.id)) {
            normalized.id = makeId('preset');
        }

        seenIds.add(normalized.id);
        presets.push(normalized);
    });

    return presets;
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
    const select = $('#bb-dir-preset-select');
    if (!select.length) {
        return;
    }

    select.empty();
    select.append('<option value="">Выбрать пресет...</option>');

    getSettings().presets.forEach((preset, index) => {
        const label = preset.meta?.generated ? `${preset.name} [ИИ]` : preset.name;
        select.append(`<option value="${index}">${escapeHtml(label)}</option>`);
    });

    const selectedIndex = getSettings().lastActivePreset;
    if (selectedIndex !== null && getSettings().presets[selectedIndex]) {
        select.val(String(selectedIndex));
    } else {
        select.val('');
    }
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

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function createPresetRecord(name, items, meta = {}) {
    return {
        id: makeId('preset'),
        name: String(name || '').trim() || 'Без названия',
        items: dedupePresetItems(items.map((item) => normalizePresetItem(item)).filter(Boolean)),
        categories: normalizeCategories(meta.categories || getCategories(), items, []),
        storage: {
            format: PRESET_FILE_FORMAT,
            version: PRESET_FILE_VERSION,
        },
        meta: {
            generated: Boolean(meta.generated),
            summary: String(meta.summary || ''),
        },
    };
}

function getCurrentDraftPresetSnapshot() {
    const items = captureCurrentPresetItems();
    if (!items.length) {
        return null;
    }

    return createPresetRecord('Черновик Scene Director', items, {
        generated: false,
        categories: getCategories(),
    });
}

function getExportPresetSnapshot() {
    const selectedIndex = getSelectedPresetIndex();
    if (selectedIndex !== null) {
        const preset = getSettings().presets[selectedIndex];
        if (preset) {
            return cloneJson(preset);
        }
    }

    return getCurrentDraftPresetSnapshot();
}

function downloadTextFile(filename, content, mimeType = 'application/json;charset=utf-8') {
    const blob = new Blob([content], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function createImportFileInput() {
    const existing = document.getElementById('bb-dir-import-file');
    if (existing instanceof HTMLInputElement) {
        return existing;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'bb-dir-import-file';
    input.accept = '.json,application/json';
    input.hidden = true;
    document.body.append(input);
    return input;
}

async function handleExportPreset() {
    const preset = getExportPresetSnapshot();
    if (!preset) {
        notify('warning', 'Сначала создай или выбери пресет для экспорта.');
        return;
    }

    const content = stringifyPresetFile(preset);
    const filename = `${sanitizePresetFilename(preset.name)}.json`;
    downloadTextFile(filename, content);
    notify('success', `Пресет "${preset.name}" экспортирован в JSON.`);
}

function importRawPresets(rawPresets) {
    const importedPresets = [];

    rawPresets.forEach((rawPreset) => {
        const normalized = normalizePreset(rawPreset, getSettings().directives);
        if (!normalized) {
            return;
        }

        normalized.id = makeId('preset');
        normalized.name = getUniquePresetName(normalized.name);
        normalized.categories = normalizeCategories(normalized.categories, normalized.items, []);
        normalized.storage = {
            format: PRESET_FILE_FORMAT,
            version: PRESET_FILE_VERSION,
        };
        getSettings().presets.push(normalized);
        importedPresets.push(normalized);
    });

    return importedPresets;
}

async function handleImportPresetFile(file) {
    if (!file) {
        return;
    }

    let parsed;
    try {
        parsed = parsePresetImportText(await file.text());
    } catch (error) {
        notify('error', `Не удалось прочитать JSON: ${error.message || error}`);
        return;
    }

    if (!parsed.presets.length) {
        notify('warning', 'В файле не найдено пригодных пресетов Scene Director.');
        return;
    }

    const imported = importRawPresets(parsed.presets);
    if (!imported.length) {
        notify('warning', 'Импорт завершился, но ни один пресет не удалось преобразовать.');
        return;
    }

    saveSettingsDebounced();
    renderPresetsDropdown();

    if (imported.length === 1) {
        const importedIndex = getSettings().presets.findIndex((preset) => preset.id === imported[0].id);
        if (importedIndex !== -1) {
            $('#bb-dir-preset-select').val(String(importedIndex));
        }
        notify('success', `Импортирован пресет "${imported[0].name}".`);
        return;
    }

    notify('success', `Импортировано пресетов: ${imported.length}.`);
}

function migrateLegacyCurrentDraft(settings) {
    const currentDirectives = Array.isArray(settings.directives) ? settings.directives : [];
    const hasInactiveTail = currentDirectives.some((directive) => directive && directive.active === false);

    if (!hasInactiveTail || currentDirectives.length === 0) {
        return false;
    }

    const backupPreset = createPresetRecord(
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

function captureCurrentPresetItems() {
    return getSettings().directives
        .map((directive) => createPresetItemFromDirective(directive));
}

function getReplacementCategoryId(removedCategoryId, categories = getCategories()) {
    const normalizedRemovedId = normalizeCategoryId(removedCategoryId, categories);
    return categories.find((category) => category.id !== normalizedRemovedId)?.id || null;
}

function applyPresetItems(items, options = {}) {
    const settings = getSettings();
    const existingById = new Map(settings.directives.map((directive) => [directive.id, directive]));
    const existingByName = new Map(settings.directives.map((directive) => [directive.name.toLowerCase(), directive]));
    const sourceCategories = options.replaceCategories && Array.isArray(options.categories) && options.categories.length
        ? options.categories
        : settings.categories;

    settings.categories = normalizeCategories(sourceCategories, items, []);
    settings.expandedCategories = normalizeExpandedCategories(settings.expandedCategories, settings.categories);

    const nextDirectives = items
        .map((rawItem) => {
            const item = normalizePresetItem(rawItem, existingByName);
            if (!item) {
                return null;
            }

            let directive = item.directiveId ? existingById.get(item.directiveId) : null;
            if (!directive) {
                directive = existingByName.get(item.name.toLowerCase());
            }

            if (!directive) {
                directive = createDirective({
                    id: item.directiveId || makeId('dir'),
                    name: item.name,
                    category: item.category,
                    value: item.value,
                    active: item.active,
                });
            } else {
                directive = {
                    ...directive,
                    name: item.name,
                    category: item.category,
                    value: item.value,
                    active: item.active !== false,
                };
            }

            return createDirective(directive);
        })
        .filter(Boolean);

    settings.directives = nextDirectives;

    if (options.expandTouchedCategories) {
        applyExpandedCategoriesFromItems(items);
    }

    if (options.clearSelectedPreset) {
        settings.lastActivePreset = null;
    }
}

async function handleLoadPreset() {
    const index = getSelectedPresetIndex();
    if (index === null) {
        notify('warning', 'Сначала выбери пресет.');
        return;
    }

    const preset = getSettings().presets[index];
    if (!preset) {
        notify('error', 'Пресет не найден.');
        return;
    }

    applyPresetItems(preset.items, {
        expandTouchedCategories: true,
        replaceCategories: Array.isArray(preset.categories) && preset.categories.length > 0,
        categories: preset.categories,
    });
    getSettings().lastActivePreset = index;
    saveSettingsDebounced();
    renderPresetsDropdown();
    renderDirectorHud();
    updateDirectorPrompt();
    notify('success', `Пресет "${preset.name}" загружен.`);
}

async function handleUpdatePreset(button) {
    const index = getSelectedPresetIndex();
    if (index === null) {
        notify('warning', 'Сначала выбери пресет для перезаписи.');
        return;
    }

    const preset = getSettings().presets[index];
    if (!preset) {
        notify('error', 'Пресет не найден.');
        return;
    }

    const confirmed = await confirmAction(
        `Перезаписать пресет "${preset.name}" текущим деревом категорий и директив?`,
        { okButton: 'Перезаписать', cancelButton: 'Отмена' },
    );

    if (!confirmed) {
        return;
    }

    preset.items = captureCurrentPresetItems();
    preset.categories = normalizeCategories(getCategories(), preset.items, []);
    saveSettingsDebounced();
    flashButton(button);
    notify('success', `Пресет "${preset.name}" обновлён.`);
}

async function handleSaveNewPreset() {
    const name = await promptText('Название нового пресета:', '', {
        okButton: 'Сохранить',
        cancelButton: 'Отмена',
    });

    if (!name || !name.trim()) {
        return;
    }

    const items = captureCurrentPresetItems();
    if (!items.length) {
        notify('warning', 'Сначала добавь хотя бы одну директиву в текущий черновик.');
        return;
    }

    const preset = createPresetRecord(name, items, {
        generated: false,
        categories: getCategories(),
    });
    getSettings().presets.push(preset);
    getSettings().lastActivePreset = getSettings().presets.length - 1;

    saveSettingsDebounced();
    renderPresetsDropdown();
    $('#bb-dir-preset-select').val(String(getSettings().lastActivePreset));
    notify('success', `Пресет "${preset.name}" сохранён.`);
}

async function handleRenamePreset() {
    const index = getSelectedPresetIndex();
    if (index === null) {
        notify('warning', 'Сначала выбери пресет.');
        return;
    }

    const preset = getSettings().presets[index];
    if (!preset) {
        notify('error', 'Пресет не найден.');
        return;
    }

    const newName = await promptText('Новое имя пресета:', preset.name, {
        okButton: 'Переименовать',
        cancelButton: 'Отмена',
    });

    if (!newName || !newName.trim()) {
        return;
    }

    preset.name = newName.trim();
    saveSettingsDebounced();
    renderPresetsDropdown();
    $('#bb-dir-preset-select').val(String(index));
    notify('success', `Пресет переименован в "${preset.name}".`);
}

async function handleDeletePreset() {
    const index = getSelectedPresetIndex();
    if (index === null) {
        notify('warning', 'Сначала выбери пресет.');
        return;
    }

    const preset = getSettings().presets[index];
    if (!preset) {
        notify('error', 'Пресет не найден.');
        return;
    }

    const confirmed = await confirmAction(
        `Удалить пресет "${preset.name}"?`,
        { okButton: 'Удалить', cancelButton: 'Отмена' },
    );

    if (!confirmed) {
        return;
    }

    getSettings().presets.splice(index, 1);

    if (getSettings().lastActivePreset === index) {
        getSettings().lastActivePreset = null;
    } else if (getSettings().lastActivePreset !== null && getSettings().lastActivePreset > index) {
        getSettings().lastActivePreset -= 1;
    }

    saveSettingsDebounced();
    renderPresetsDropdown();
    notify('success', `Пресет "${preset.name}" удалён.`);
}

function getCategoryUsageSnapshot(categoryId) {
    const normalizedId = normalizeCategoryId(categoryId, getCategories());
    const directiveCount = getSettings().directives.filter((directive) => directive.category === normalizedId).length;
    const presetRefs = getSettings().presets.reduce((count, preset) => {
        const items = Array.isArray(preset?.items) ? preset.items : [];
        return count + items.filter((item) => slugifyCategoryId(item?.category) === normalizedId).length;
    }, 0);

    return {
        categoryId: normalizedId,
        draftDirectiveCount: directiveCount,
        presetRefs,
    };
}

async function handleDeleteCategory(categoryId) {
    const settings = getSettings();
    const categories = getCategories();
    const normalizedId = normalizeCategoryId(categoryId, categories);
    const category = categories.find((item) => item.id === normalizedId);

    if (!category) {
        notify('error', 'Категория не найдена.');
        return;
    }

    if (categories.length <= 1) {
        notify('warning', 'Нельзя удалить последнюю категорию.');
        return;
    }

    const usage = getCategoryUsageSnapshot(normalizedId);
    const details = [];
    if (usage.draftDirectiveCount) {
        details.push(`директив в текущем черновике: ${usage.draftDirectiveCount}`);
    }
    if (usage.presetRefs) {
        details.push(`используется в сохранённых пресетах: ${usage.presetRefs}`);
    }

    const confirmed = await confirmAction(
        [
            `Удалить категорию "${category.label}"?`,
            details.length ? `Что найдено: ${details.join(', ')}.` : 'Связанных данных не найдено.',
            'Сохранённые пресеты не будут изменены.',
            'Из текущего черновика будут удалены только сама категория и её директивы.',
        ].join('\n'),
        { okButton: 'Удалить категорию', cancelButton: 'Отмена' },
    );

    if (!confirmed) {
        return;
    }

    settings.directives = settings.directives.filter((directive) => directive.category !== normalizedId);
    settings.categories = settings.categories.filter((item) => item.id !== normalizedId);
    settings.expandedCategories = normalizeExpandedCategories(settings.expandedCategories, settings.categories);
    settings.lastActivePreset = null;

    saveSettingsDebounced();
    renderPresetsDropdown();
    renderDirectorHud();
    updateDirectorPrompt();
    notify('success', `Категория "${category.label}" удалена.`);
}

function findDirectiveByCard(cardElement) {
    const directiveId = String($(cardElement).closest('.bb-dir-card').data('id') || '');
    return getSettings().directives.find((directive) => directive.id === directiveId) || null;
}

function updateStealthButtonState() {
    const button = $('#bb-dir-stealth-btn');
    if (!button.length) {
        return;
    }

    const isActive = getSettings().hideInactive;
    const icon = isActive ? 'fa-eye' : 'fa-eye-slash';
    const label = isActive ? 'Показать неактивные' : 'Скрыть неактивные';

    button.toggleClass('is-active', isActive);
    button.html(`<i class="fa-solid ${icon}"></i><span>${escapeHtml(label)}</span>`);
}

function renderPreviewToggleState() {
    const settings = getSettings();
    const toggleButton = $('#bb-dir-preview-toggle');
    const previewWrap = $('#bb-dir-preview-wrap');
    const isExpanded = Boolean(settings.previewExpanded);
    const icon = isExpanded ? 'fa-eye-slash' : 'fa-eye';
    const label = isExpanded ? 'Скрыть инструкцию' : 'Показать инструкцию';

    if (toggleButton.length) {
        toggleButton.toggleClass('is-active', isExpanded);
        toggleButton.html(`<i class="fa-solid ${icon}"></i><span>${escapeHtml(label)}</span>`);
    }

    if (previewWrap.length) {
        previewWrap.prop('hidden', !isExpanded);
    }
}

function revealDirectiveCardIfNeeded() {
    if (!state.revealDirectiveId || typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
        state.revealDirectiveId = null;
        return;
    }

    const selector = `.bb-dir-card[data-id="${CSS.escape(state.revealDirectiveId)}"]`;
    const card = document.querySelector(selector);
    state.revealDirectiveId = null;

    if (!card) {
        return;
    }

    card.classList.add('bb-dir-card-new');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    window.setTimeout(() => {
        card.classList.remove('bb-dir-card-new');
    }, 1600);
}

function renderDirectiveCard(directive) {
    const inactiveClass = directive.active ? '' : 'is-inactive';
    const toggleIcon = directive.active ? 'fa-eye' : 'fa-eye-slash';

    return [
        `<article class="bb-dir-card ${inactiveClass}" data-id="${escapeHtml(directive.id)}">`,
        '<div class="bb-dir-card-head">',
        '<div class="bb-dir-card-main">',
        `<input type="text" class="bb-dir-name bb-dir-input" value="${escapeHtml(directive.name)}" placeholder="Название директивы">`,
        '</div>',
        '<div class="bb-dir-card-actions">',
        `<button class="bb-dir-btn interactable bb-dir-toggle" title="${directive.active ? 'Выключить' : 'Включить'}"><i class="fa-solid ${toggleIcon}"></i></button>`,
        '<button class="bb-dir-btn interactable bb-dir-delete" title="Удалить"><i class="fa-solid fa-trash"></i></button>',
        '</div>',
        '</div>',
        '<div class="bb-dir-slider-row">',
        '<span class="bb-dir-slider-min">0%</span>',
        `<input type="range" class="bb-dir-slider" min="0" max="100" step="5" value="${directive.value}">`,
        `<span class="bb-dir-slider-value">${directive.value}%</span>`,
        '</div>',
        '<div class="bb-dir-card-foot">',
        `<span class="bb-dir-level-pill">${escapeHtml(getIntensityLabel(directive.value))}</span>`,
        `<select class="bb-dir-category-select bb-dir-input" title="Категория">${renderCategoryOptions(directive.category)}</select>`,
        '</div>',
        '</article>',
    ].join('');
}

function renderCategoryOptions(selectedCategory) {
    const categories = getCategories();
    return categories.map((category) => {
        const selected = category.id === normalizeCategoryId(selectedCategory, categories) ? ' selected' : '';
        return `<option value="${escapeHtml(category.id)}"${selected}>${escapeHtml(category.label)}</option>`;
    }).join('');
}

function renderDirectorHud() {
    const root = $('#bb-dir-list');
    if (!root.length) {
        return;
    }

    const categories = getCategories();
    const groups = groupDirectivesByCategory(getSettings().directives);
    const shouldHideInactive = getSettings().hideInactive;
    const expandedCategories = normalizeExpandedCategories(getSettings().expandedCategories, categories);

    const sections = categories.map((category) => {
        const allDirectives = groups.get(category.id) || [];
        const directives = allDirectives.filter((directive) => !shouldHideInactive || directive.active);
        const activeCount = allDirectives.filter((directive) => directive.active).length;
        const isExpanded = Boolean(expandedCategories[category.id]);
        const canDeleteCategory = categories.length > 1;
        const countText = allDirectives.length
            ? `${activeCount} активных / ${allDirectives.length}`
            : 'Пусто';

        const cards = directives.map((directive) => renderDirectiveCard(directive)).join('');
        const emptyState = cards
            ? ''
            : shouldHideInactive && allDirectives.length > 0
                ? '<div class="bb-dir-empty">В этой секции сейчас скрыты только неактивные директивы. Нажми <b>+</b>, чтобы добавить новую активную.</div>'
                : '<div class="bb-dir-empty">Пусто. Нажми <b>+</b>, чтобы добавить первую директиву.</div>';

        return [
            `<section class="bb-dir-section ${isExpanded ? 'is-expanded' : 'is-collapsed'}" data-category-id="${escapeHtml(category.id)}">`,
            '<div class="bb-dir-section-head">',
            `<button type="button" class="bb-dir-section-toggle" data-category-id="${escapeHtml(category.id)}" aria-expanded="${isExpanded ? 'true' : 'false'}">`,
            '<div class="bb-dir-section-meta">',
            '<div class="bb-dir-section-topline">',
            `<div class="bb-dir-section-title">${escapeHtml(category.label)}</div>`,
            `<div class="bb-dir-section-count">${escapeHtml(countText)}</div>`,
            '</div>',
            `<div class="bb-dir-section-hint">${escapeHtml(category.hint)}</div>`,
            '</div>',
            `<span class="bb-dir-section-arrow"><i class="fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i></span>`,
            '</button>',
            '<div class="bb-dir-section-actions">',
            `<button class="bb-dir-btn interactable bb-dir-section-add" data-category-id="${escapeHtml(category.id)}" title="Добавить в секцию"><i class="fa-solid fa-plus"></i></button>`,
            `<button class="bb-dir-btn interactable bb-dir-section-delete${canDeleteCategory ? '' : ' is-disabled'}" data-category-id="${escapeHtml(category.id)}" title="Удалить категорию"${canDeleteCategory ? '' : ' disabled'}><i class="fa-solid fa-trash"></i></button>`,
            '</div>',
            '</div>',
            `<div class="bb-dir-section-list" data-category-id="${escapeHtml(category.id)}"${isExpanded ? '' : ' hidden'}>`,
            cards,
            emptyState,
            '</div>',
            '</section>',
        ].join('');
    }).join('');

    root.html(sections);

    updateStealthButtonState();
    renderPreviewToggleState();
    requestAnimationFrame(revealDirectiveCardIfNeeded);
}

function buildCustomHeadersYaml(apiKey) {
    const trimmed = String(apiKey || '').trim();
    if (!trimmed) {
        return '';
    }

    const authValue = trimmed.startsWith('Bearer ') ? trimmed : `Bearer ${trimmed}`;
    return `Authorization: ${JSON.stringify(authValue)}`;
}

function createMasterApiHeaders(apiKey, { includeJson = false } = {}) {
    const headers = {};
    const trimmed = String(apiKey || '').trim();

    if (includeJson) {
        headers['Content-Type'] = 'application/json';
    }

    if (trimmed) {
        headers.Authorization = trimmed.startsWith('Bearer ') ? trimmed : `Bearer ${trimmed}`;
    }

    return headers;
}

function buildMasterBackendPayload(url, apiKey) {
    return {
        chat_completion_source: chat_completion_sources.CUSTOM,
        custom_url: normalizeBaseUrl(url),
        custom_include_headers: buildCustomHeadersYaml(apiKey),
    };
}

function createTimedAbortController(timeoutMs, timeoutMessage) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
        controller.abort(timeoutMessage);
    }, timeoutMs);

    return {
        controller,
        cleanup() {
            window.clearTimeout(timeoutId);
        },
    };
}

function isAbortLikeError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || error || '').toLowerCase();

    return name === 'AbortError'
        || message.includes('aborted')
        || message.includes('abort')
        || message.includes('отмен')
        || message.includes('cancel');
}

function abortMasterGeneration(reason = 'Отменено пользователем.') {
    if (state.masterAbortController && !state.masterAbortController.signal.aborted) {
        state.masterAbortController.abort(reason);
    }
}

async function readJsonResponseOrEmpty(response) {
    try {
        return await response.json();
    } catch {
        return {};
    }
}

function extractMasterApiError(response, responseData, fallbackMessage) {
    return responseData?.message
        || responseData?.error?.message
        || response.statusText
        || fallbackMessage;
}

function markMasterConnectionDirty(options = {}) {
    const { clearModels = false } = options;
    const master = getSettings().masterPreset;
    master.statusLevel = 'idle';
    master.statusText = 'Параметры изменились. Нажми «Подключиться», чтобы обновить статус и список моделей генератора.';

    if (clearModels) {
        master.availableModels = [];
    }

    saveSettingsDebounced();
    renderMasterControls();
}

function getResolvedMasterContext() {
    const resolved = substituteParams(MASTER_CONTEXT_TEMPLATE);

    return resolved
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => {
            if (!line) {
                return false;
            }

            const parts = line.split(':');
            if (parts.length < 2) {
                return true;
            }

            const value = parts.slice(1).join(':').trim();
            if (!value) {
                return false;
            }

            if (/\{\{.+\}\}/.test(value)) {
                return false;
            }

            return true;
        })
        .join('\n');
}

function inferMasterLanguage(sourceText) {
    const text = String(sourceText || '');
    const counters = {
        ru: (text.match(/[А-Яа-яЁё]/g) || []).length,
        ja: (text.match(/[\u3040-\u30ff\u31f0-\u31ff\u4e00-\u9faf]/g) || []).length,
        ko: (text.match(/[\uac00-\ud7af]/g) || []).length,
        en: (text.match(/[A-Za-z]/g) || []).length,
    };

    const sorted = Object.entries(counters).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[1] ? sorted[0][0] : 'en';
}

function getMasterLanguageMeta(languageCode) {
    const map = {
        ru: { code: 'ru', labelRu: 'русский', labelEn: 'Russian' },
        en: { code: 'en', labelRu: 'английский', labelEn: 'English' },
        ja: { code: 'ja', labelRu: 'японский', labelEn: 'Japanese' },
        ko: { code: 'ko', labelRu: 'корейский', labelEn: 'Korean' },
    };

    return map[languageCode] || map.en;
}

function buildMasterSystemPrompt(categories, languageMeta) {
    const categorySummary = categories
        .map((category) => `- ${category.id}: ${category.label}${category.hint ? ` (${category.hint})` : ''}`)
        .join('\n');

    return [
        'You are a scene-directing preset generator for roleplay chats.',
        'Return JSON only. No markdown, no prose, no explanations.',
        `Write presetName, category labels, category hints, and directive names in ${languageMeta.labelEn}.`,
        'You may keep, remove, merge, rename, or add categories if it materially improves the preset.',
        'Return a complete preset tree in one response.',
        'Keep directive names short, reusable, concrete, and useful across several replies.',
        'Use values from 0 to 100 in steps of 5.',
        'Return 3 to 7 categories and usually 6 to 14 directives total.',
        'Prefer 1 to 4 directives per category.',
        'Avoid duplicates, synonyms, and filler.',
        'Directives must shape tone, pacing, framing, conflict, intimacy, escalation, and scene movement.',
        'Do not mention the source text inside directive names.',
        'If data is missing, omit weak ideas instead of inventing filler.',
        'Category ids must be short lowercase slugs using latin letters, numbers, or hyphens.',
        'Every directive must live inside its category.directives array.',
        'Current categories to consider as input, not as a hard limit:',
        categorySummary || '- none',
        'Schema reminder:',
        '{',
        '  "presetName": "short preset name",',
        '  "categories": [',
        '    {',
        '      "id": "category-slug",',
        '      "label": "category label",',
        '      "promptLabel": "short uppercase-ready label",',
        '      "hint": "short category description",',
        '      "directives": [',
        '        {',
        '          "name": "short directive name",',
        '          "value": 0,',
        '          "active": true',
        '        }',
        '      ]',
        '    }',
        '  ]',
        '}',
    ].join('\n');
}

function buildMasterMessages() {
    const sourceText = getResolvedMasterContext();
    const categories = getCategories();
    const languageMeta = getMasterLanguageMeta(inferMasterLanguage(sourceText));
    const categoryLines = categories
        .map((category) => `- ${category.id} (${category.label}): ${category.hint || 'без подсказки'}`)
        .join('\n');

    const userPrompt = [
        'Собери пресет Scene Director для ролевого чата.',
        `Язык результата: ${languageMeta.labelRu} (${languageMeta.code}).`,
        'Собери его за один ответ, как полноценное дерево категорий и директив.',
        'Ты можешь оставить подходящие категории, удалить лишние, объединить похожие и добавить новые, если это сделает пресет сильнее.',
        'Подумай, какие акценты реально помогут сцене: тон, близость, энергия, конфликт, развитие, твисты, атмосферу, ритм.',
        'Не делай мусорных или слишком общих директив. Лучше меньше, но точнее.',
        'Верни только итоговый JSON-объект, без пояснений.',
        '',
        'Текущие категории в интерфейсе:',
        categoryLines,
        '',
        'Данные о персонаже и пользователе:',
        sourceText || '(данных недостаточно)',
    ].join('\n');

    return {
        sourceText,
        systemPrompt: buildMasterSystemPrompt(categories, languageMeta),
        userPrompt,
    };
}

function getMasterFallbackPresetName(sourceText) {
    const match = String(sourceText || '').match(/Имя персонажа:\s*(.+)/i);
    const charName = String(match?.[1] || '').trim();
    if (charName) {
        return `Scene Director: ${charName.slice(0, 48)}`;
    }

    return 'Scene Director Preset';
}

function buildMasterCategoryRawMessages(category, options = {}) {
    const sourceText = getResolvedMasterContext();
    const languageMeta = getMasterLanguageMeta(inferMasterLanguage(sourceText));
    const {
        slotIndex = 0,
        targetCount = MASTER_FALLBACK_CATEGORY_TARGETS[category.id] || 2,
        existingItems = [],
    } = options;
    const usedNames = existingItems
        .map((item) => String(item?.name || '').trim())
        .filter(Boolean)
        .join('; ');
    const systemPrompt = [
        'You create Scene Director directives for one category in a roleplay preset.',
        'Return plain text only. No JSON. No markdown. No explanations.',
        `Write the directive name in ${languageMeta.labelEn}.`,
        'Output exactly one directive in exactly one line in this format:',
        `ITEM|${category.id}|70|short directive name`,
        'Rules:',
        `- Use only the category "${category.id}".`,
        '- Return exactly one ITEM line.',
        '- Start immediately with ITEM| on the first line.',
        '- No preset name line.',
        '- Directive names must be short, concrete, reusable, and without quotes or pipe symbols.',
        '- Values must be integers from 0 to 100 in steps of 5.',
        '- Avoid duplicates, filler, and generic wording.',
        '- Make directives materially useful for steering replies.',
        '- Do not repeat already used directives.',
    ].join('\n');

    const userPrompt = [
        `Собери директивы только для категории ${category.id}.`,
        `Язык результата: ${languageMeta.labelRu} (${languageMeta.code}).`,
        `Категория ${category.id} / ${category.label}: ${category.hint || 'без описания'}.`,
        `Сейчас нужен слот ${slotIndex + 1} из ${targetCount} для этой категории.`,
        'Нужна одна сильная директива именно для этой категории.',
        'Не повторяй соседние идеи разными словами.',
        usedNames ? `Уже использованные директивы этой категории: ${usedNames}` : 'Пока в этой категории ещё нет выбранных директив.',
        '',
        'Полный контекст персонажа и пользователя:',
        sourceText || '(данных недостаточно)',
    ].join('\n');

    return {
        sourceText,
        systemPrompt,
        userPrompt,
    };
}

function getMasterConnectionDetails() {
    const master = getSettings().masterPreset;
    const url = normalizeBaseUrl(master.url);
    const model = String(master.model || '').trim();

    if (!url) {
        throw new Error('Укажи URL подключения.');
    }

    return {
        url,
        apiKey: String(master.apiKey || ''),
        model,
    };
}

async function fetchMasterModelsDirect(url, apiKey, signal = undefined) {
    const response = await fetch(`${url}/models`, {
        method: 'GET',
        headers: createMasterApiHeaders(apiKey),
        signal,
    });
    const responseData = await readJsonResponseOrEmpty(response);

    if (!response.ok) {
        throw new Error(extractMasterApiError(response, responseData, 'Не удалось загрузить список моделей.'));
    }

    return extractModelIds(responseData);
}

async function fetchMasterModelsViaBackend(url, apiKey, signal = undefined) {
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        signal,
        body: JSON.stringify(buildMasterBackendPayload(url, apiKey)),
    });
    const responseData = await readJsonResponseOrEmpty(response);

    if (!response.ok || responseData?.error) {
        throw new Error(extractMasterApiError(response, responseData, 'Не удалось проверить подключение через SillyTavern.'));
    }

    return extractModelIds(responseData);
}

function extractMasterResponseContent(responseData) {
    if (!responseData || typeof responseData !== 'object') {
        return '';
    }

    const messageContent = responseData?.choices?.[0]?.message?.content;
    if (Array.isArray(messageContent)) {
        return messageContent
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }

                if (part && typeof part === 'object') {
                    return String(part.text || part.content || '');
                }

                return '';
            })
            .join('')
            .trim();
    }

    if (typeof messageContent === 'string') {
        return messageContent.trim();
    }

    if (messageContent && typeof messageContent === 'object') {
        return String(messageContent.text || messageContent.content || '').trim();
    }

    const textContent = responseData?.choices?.[0]?.text;
    if (typeof textContent === 'string') {
        return textContent.trim();
    }

    if (typeof responseData.content === 'string') {
        return responseData.content.trim();
    }

    return '';
}

function describeMasterResponseSnippet(rawResponse) {
    if (typeof rawResponse === 'string') {
        return rawResponse.slice(0, 1200);
    }

    try {
        return JSON.stringify(rawResponse, null, 2).slice(0, 1200);
    } catch {
        return String(rawResponse || '').slice(0, 1200);
    }
}

async function requestMasterPresetDirect({ url, apiKey, model, messages, maxTokens, temperature, signal }) {
    const headers = createMasterApiHeaders(apiKey, { includeJson: true });
    const basePayload = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
    };
    const attempts = [
        { ...basePayload, max_completion_tokens: maxTokens, max_output_tokens: maxTokens },
        { ...basePayload, max_completion_tokens: maxTokens },
        basePayload,
    ];
    let lastError = null;

    for (const payload of attempts) {
        const response = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers,
            signal,
            body: JSON.stringify(payload),
        });

        const responseData = await readJsonResponseOrEmpty(response);
        if (response.ok) {
            return extractMasterResponseContent(responseData) || responseData;
        }

        lastError = new Error(extractMasterApiError(response, responseData, 'Не удалось получить ответ от кастомной модели.'));
        const message = String(lastError.message || '');
        const looksLikeTokenFieldIssue = /max_completion_tokens|max_tokens|unknown|unexpected|unsupported/i.test(message);

        if (!looksLikeTokenFieldIssue || payload === basePayload) {
            throw lastError;
        }
    }

    throw lastError || new Error('Не удалось получить ответ от кастомной модели.');
}

async function requestMasterPresetViaBackend({ url, apiKey, model, messages, maxTokens, temperature, signal, jsonSchema = null }) {
    const context = SillyTavern.getContext();
    const requestPayload = {
        stream: false,
        messages,
        model,
        max_tokens: maxTokens,
        temperature,
        ...buildMasterBackendPayload(url, apiKey),
    };

    if (jsonSchema) {
        requestPayload.json_schema = jsonSchema;
    }

    const response = await context.ChatCompletionService.processRequest(requestPayload, {}, true, signal);

    return response?.content ?? response;
}

function extractModelIds(responseData) {
    const rawModels = Array.isArray(responseData?.data)
        ? responseData.data
        : Array.isArray(responseData?.models)
            ? responseData.models
            : Array.isArray(responseData)
                ? responseData
                : [];

    return [...new Set(rawModels
        .map((item) => {
            if (typeof item === 'string') {
                return item;
            }

            if (item && typeof item === 'object') {
                if (typeof item.id === 'string') {
                    return item.id;
                }

                if (typeof item.name === 'string') {
                    return item.name;
                }
            }

            return '';
        })
        .map((item) => item.trim())
        .filter(Boolean))];
}

async function checkMasterConnection() {
    const master = getSettings().masterPreset;
    let connection;
    const { controller, cleanup } = createTimedAbortController(
        MASTER_STATUS_TIMEOUT_MS,
        'Проверка подключения заняла слишком много времени.',
    );

    try {
        connection = getMasterConnectionDetails();
    } catch (error) {
        cleanup();
        notify('warning', error.message || 'Проверь параметры подключения.');
        return;
    }

    state.masterChecking = true;
    renderMasterControls();

    try {
        let modelIds = [];
        try {
            modelIds = await fetchMasterModelsDirect(connection.url, connection.apiKey, controller.signal);
        } catch (directError) {
            console.warn('[BB Scene Director] Direct model check failed, trying backend fallback.', directError);
            if (isAbortLikeError(directError)) {
                throw directError;
            }
            modelIds = await fetchMasterModelsViaBackend(connection.url, connection.apiKey, controller.signal);
        }

        master.availableModels = modelIds;

        if (!modelIds.length) {
            throw new Error('Список моделей пустой.');
        }

        if (!master.model || !modelIds.includes(master.model)) {
            master.model = modelIds[0];
        }

        master.statusLevel = 'success';
        master.statusText = `Подключено. Найдено моделей: ${modelIds.length}.`;

        saveSettingsDebounced();
        renderMasterControls();
        notify('success', 'Подключение проверено.');
    } catch (error) {
        master.availableModels = [];
        master.statusLevel = 'error';
        master.statusText = isAbortLikeError(error)
            ? String(controller.signal.reason || error.message || 'Проверка подключения была остановлена.')
            : (error.message || 'Не удалось проверить подключение.');
        saveSettingsDebounced();
        renderMasterControls();
        notify(isAbortLikeError(error) ? 'warning' : 'error', master.statusText);
    } finally {
        cleanup();
        state.masterChecking = false;
        renderMasterControls();
    }
}

function cleanupMarkdownFences(rawText) {
    return String(rawText || '')
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();
}

function extractBalancedSegment(rawText, openChar = '{', closeChar = '}') {
    const source = String(rawText || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (inString) {
            continue;
        }

        if (char === openChar) {
            if (start === -1) {
                start = index;
            }
            depth += 1;
            continue;
        }

        if (char === closeChar && depth > 0) {
            depth -= 1;
            if (start !== -1 && depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    return '';
}

function extractJsonCandidate(rawText) {
    const text = cleanupMarkdownFences(rawText);
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
    }

    const objectCandidate = extractBalancedSegment(text, '{', '}');
    if (objectCandidate) {
        return objectCandidate.trim();
    }

    return text;
}

function quoteBareJsonObjectKeys(rawText) {
    return String(rawText || '').replace(/([{,]\s*)([A-Za-zА-Яа-я_][\wА-Яа-я-]*)(\s*:)/g, '$1"$2"$3');
}

function stripJsonLikeComments(rawText) {
    const source = String(rawText || '');
    let result = '';
    let inString = false;
    let escapeNext = false;

    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        const next = source[index + 1];

        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            result += char;
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            result += char;
            inString = !inString;
            continue;
        }

        if (!inString && char === '/' && next === '/') {
            while (index < source.length && source[index] !== '\n') {
                index += 1;
            }

            if (index < source.length) {
                result += '\n';
            }
            continue;
        }

        if (!inString && char === '/' && next === '*') {
            index += 2;
            while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
                index += 1;
            }
            index += 1;
            continue;
        }

        result += char;
    }

    return result;
}

function escapeUnescapedJsonStringChars(rawText) {
    const source = String(rawText || '');
    let result = '';
    let inString = false;
    let escapeNext = false;

    for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            result += char;
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            result += char;
            inString = !inString;
            continue;
        }

        if (inString) {
            if (char === '\n') {
                result += '\\n';
                continue;
            }

            if (char === '\r') {
                result += '\\r';
                continue;
            }

            if (char === '\t') {
                result += '\\t';
                continue;
            }
        }

        result += char;
    }

    return result;
}

function repairJsonCandidate(rawText) {
    return escapeUnescapedJsonStringChars(
        stripJsonLikeComments(
            cleanupMarkdownFences(rawText),
        )
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/\bTrue\b/g, 'true')
            .replace(/\bFalse\b/g, 'false')
            .replace(/\bNone\b/g, 'null')
            .replace(/,\s*([\]}])/g, '$1')
            .trim(),
    );
}

function convertSingleQuotedStringsToDoubleJson(rawText) {
    const source = String(rawText || '');
    let result = '';
    let inSingle = false;
    let inDouble = false;
    let escapeNext = false;

    for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            result += char;
            escapeNext = true;
            continue;
        }

        if (char === '"' && !inSingle) {
            result += char;
            inDouble = !inDouble;
            continue;
        }

        if (char === '\'' && !inDouble) {
            result += '"';
            inSingle = !inSingle;
            continue;
        }

        if (inSingle && char === '"') {
            result += '\\"';
            continue;
        }

        result += char;
    }

    return result;
}

function insertMissingJsonCommas(rawText) {
    return String(rawText || '')
        .replace(
            /("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\]}])(\s*)(?="(?:\\.|[^"\\])*"\s*:)/g,
            '$1,$2',
        )
        .replace(
            /("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\]}])(\s*)(?=[{\[])/g,
            '$1,$2',
        );
}

function balanceJsonClosers(rawText) {
    const source = String(rawText || '');
    const closers = [];
    let inString = false;
    let escapeNext = false;

    for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (inString) {
            continue;
        }

        if (char === '{') {
            closers.push('}');
            continue;
        }

        if (char === '[') {
            closers.push(']');
            continue;
        }

        if ((char === '}' || char === ']') && closers.length) {
            const expected = closers[closers.length - 1];
            if (char === expected) {
                closers.pop();
            }
        }
    }

    return `${source}${closers.reverse().join('')}`;
}

function repairLooseJsonCandidate(rawText) {
    return balanceJsonClosers(
        insertMissingJsonCommas(
            escapeUnescapedJsonStringChars(
                convertSingleQuotedStringsToDoubleJson(
                    quoteBareJsonObjectKeys(
                        repairJsonCandidate(rawText),
                    ),
                ).replace(/,\s*([\]}])/g, '$1'),
            ),
        ),
    );
}

function normalizeParsedMasterObject(parsed) {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
    }

    if (Array.isArray(parsed)) {
        return parsed.find((item) => item && typeof item === 'object' && !Array.isArray(item)) || null;
    }

    return null;
}

function normalizeMasterCategoryOutput(rawCategory, index = 0) {
    if (!rawCategory || typeof rawCategory !== 'object') {
        return null;
    }

    const category = createCategoryRecord({
        id: rawCategory.id || rawCategory.key || rawCategory.slug || rawCategory.category,
        label: rawCategory.label || rawCategory.name,
        promptLabel: rawCategory.promptLabel || rawCategory.prompt_label || rawCategory.label || rawCategory.name,
        hint: rawCategory.hint || rawCategory.description || rawCategory.summary || '',
    }, index);

    const directives = (Array.isArray(rawCategory.directives)
        ? rawCategory.directives
        : Array.isArray(rawCategory.items)
            ? rawCategory.items
            : [])
        .filter((directive) => directive && typeof directive === 'object' && String(directive.name || '').trim());

    return {
        category,
        directives,
    };
}

function decodeJsonStringFragment(value) {
    try {
        return JSON.parse(`"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    } catch {
        return String(value || '')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
}

function extractJsonLikeStringValue(rawText, keyName) {
    const pattern = new RegExp(`["']${keyName}["']\\s*:\\s*["']((?:\\\\.|[^"'\\\\])*)["']`, 'i');
    const match = String(rawText || '').match(pattern);
    if (!match?.[1]) {
        return '';
    }

    return decodeJsonStringFragment(match[1]).trim();
}

function extractCompletedObjectsFromArray(rawText, keyName) {
    const text = String(rawText || '');
    const keyPattern = new RegExp(`["']${keyName}["']\\s*:`);
    const keyMatch = keyPattern.exec(text);
    if (!keyMatch) {
        return [];
    }

    const arrayStart = text.indexOf('[', keyMatch.index);
    if (arrayStart === -1) {
        return [];
    }

    const objects = [];
    let objectStart = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let index = arrayStart + 1; index < text.length; index++) {
        const char = text[index];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (inString) {
            continue;
        }

        if (char === '{') {
            if (depth === 0) {
                objectStart = index;
            }
            depth += 1;
            continue;
        }

        if (char === '}') {
            if (depth > 0) {
                depth -= 1;
                if (depth === 0 && objectStart !== -1) {
                    objects.push(text.slice(objectStart, index + 1));
                    objectStart = -1;
                }
            }
            continue;
        }

        if (char === ']' && depth === 0) {
            break;
        }
    }

    return objects;
}

function salvagePartialMasterPreset(rawText) {
    const preparedCandidates = [
        repairLooseJsonCandidate(rawText),
        repairJsonCandidate(rawText),
        cleanupMarkdownFences(rawText),
    ].filter((value, index, array) => {
        const text = String(value || '').trim();
        return text && array.findIndex((item) => item === value) === index;
    });

    for (const candidate of preparedCandidates) {
        const presetName = extractJsonLikeStringValue(candidate, 'presetName')
            || extractJsonLikeStringValue(candidate, 'name')
            || 'Мастер-пресет';
        const categoryObjects = extractCompletedObjectsFromArray(candidate, 'categories');

        if (!categoryObjects.length) {
            continue;
        }

        const categories = [];
        const directives = [];

        for (const categoryText of categoryObjects) {
            const variants = [
                categoryText,
                repairLooseJsonCandidate(categoryText),
                repairJsonCandidate(categoryText),
            ].filter((value, index, array) => array.indexOf(value) === index);

            for (const variant of variants) {
                try {
                    const parsedCategory = JSON.parse(variant);
                    const normalizedCategory = normalizeMasterCategoryOutput(parsedCategory, categories.length);
                    if (!normalizedCategory) {
                        continue;
                    }

                    categories.push(normalizedCategory.category);
                    normalizedCategory.directives.forEach((directive) => {
                        directives.push({
                            ...directive,
                            category: normalizedCategory.category.id,
                        });
                    });
                    break;
                } catch {
                    // Try the next repaired variant for this category chunk.
                }
            }
        }

        if (categories.length && directives.length) {
            return {
                presetName,
                partial: true,
                categories: categories.map((category) => ({
                    ...category,
                    directives: directives
                        .filter((directive) => directive.category === category.id)
                        .map((directive) => ({
                            name: directive.name,
                            value: directive.value,
                            active: directive.active !== false,
                        })),
                })),
            };
        }
    }

    return null;
}

function normalizeMasterPresetPayload(parsed) {
    const object = normalizeParsedMasterObject(parsed);
    if (!object) {
        return null;
    }

    if (Array.isArray(object.directives)) {
        return {
            presetName: String(object.presetName || object.name || 'Мастер-пресет').trim() || 'Мастер-пресет',
            partial: Boolean(object.partial),
            categories: Array.isArray(object.categories) && object.categories.length
                ? normalizeCategories(object.categories, object.directives, [])
                : getCategories(),
            directives: object.directives,
        };
    }

    if (Array.isArray(object.categories)) {
        const categories = [];
        const items = [];
        let skippedCategoryCount = 0;

        object.categories.forEach((rawCategory, index) => {
            const normalizedCategory = normalizeMasterCategoryOutput(rawCategory, index);
            if (!normalizedCategory || !normalizedCategory.directives.length) {
                skippedCategoryCount += 1;
                return;
            }

            categories.push(normalizedCategory.category);
            normalizedCategory.directives.forEach((directive) => {
                items.push({
                    ...directive,
                    category: normalizedCategory.category.id,
                });
            });
        });

        return {
            presetName: String(object.presetName || object.name || 'Мастер-пресет').trim() || 'Мастер-пресет',
            partial: Boolean(object.partial) || skippedCategoryCount > 0,
            categories,
            directives: items,
        };
    }

    const sourceItems = Array.isArray(object.directives)
        ? object.directives
        : Array.isArray(object.items)
            ? object.items
            : [];

    return {
        presetName: String(object.presetName || object.name || 'Мастер-пресет').trim() || 'Мастер-пресет',
        partial: Boolean(object.partial),
        categories: getCategories(),
        directives: sourceItems,
    };
}

function parseMasterLineResponse(rawResponse) {
    const text = cleanupMarkdownFences(String(rawResponse || '')).replace(/\r/g, '').trim();
    if (!text) {
        throw new Error('Модель вернула пустой текстовый ответ.');
    }

    let presetName = '';
    const collectedItems = [];
    const categoryIds = getCategories().map((category) => category.id);
    const categoryPattern = new RegExp(`^(${categoryIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\|`, 'i');

    const parseLineTokens = (line) => line
        .split('|')
        .map((part) => String(part || '').trim())
        .filter(Boolean);

    for (const rawLine of text.split('\n')) {
        const line = String(rawLine || '').trim().replace(/^[*-]\s*/, '');
        if (!line) {
            continue;
        }

        const upperLine = line.toUpperCase();
        if (upperLine.startsWith('PRESET|')) {
            const [, ...rest] = parseLineTokens(line);
            presetName = rest.join(' | ').trim() || presetName;
            continue;
        }

        let tokens = [];
        if (upperLine.startsWith('ITEM|')) {
            tokens = parseLineTokens(line).slice(1);
        } else if (categoryPattern.test(line)) {
            tokens = parseLineTokens(line);
        } else {
            continue;
        }

        if (tokens.length < 3) {
            continue;
        }

        let category = '';
        let name = '';
        let value = '';
        let active = 'true';

        if (/^\d+%?$/i.test(tokens[1])) {
            [category, value, name, active = 'true'] = tokens;
        } else {
            [category, name, value, active = 'true'] = tokens;
        }

        collectedItems.push({
            category,
            name: String(name || '').replace(/["']/g, '').trim(),
            value: Number(String(value || '').replace(/[^\d.-]/g, '')),
            active: !/^(false|off|0|no)$/i.test(String(active || '').trim()),
        });
    }

    const directivesByName = new Map(getSettings().directives.map((directive) => [directive.name.toLowerCase(), directive]));
    const items = dedupePresetItems(
        collectedItems
            .map((item) => normalizePresetItem(item, directivesByName))
            .filter(Boolean),
    );

    if (!items.length) {
        throw new Error('Модель не вернула ни одной пригодной ITEM-строки.');
    }

    return {
        presetName: presetName || 'Собранный пресет',
        items,
    };
}

function getMasterPresetQuality(items) {
    const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const categorySet = new Set(normalizedItems.map((item) => normalizeCategoryId(item.category, getCategories())));

    return {
        itemCount: normalizedItems.length,
        categoryCount: categorySet.size,
        categories: [...categorySet],
    };
}

function validateMasterPresetQuality(items, options = {}) {
    const quality = getMasterPresetQuality(items);
    const minimumCategoryCount = Math.min(MASTER_MIN_CATEGORY_COUNT, Math.max(1, getCategories().length));
    const partialMinimumCategoryCount = Math.min(2, Math.max(1, getCategories().length));
    const passesFullCheck = quality.itemCount >= MASTER_MIN_DIRECTIVE_COUNT && quality.categoryCount >= minimumCategoryCount;
    const passesPartialCheck = Boolean(options.allowPartial)
        && quality.itemCount >= MASTER_MIN_DIRECTIVE_COUNT
        && quality.categoryCount >= partialMinimumCategoryCount;

    if (!passesFullCheck && !passesPartialCheck) {
        throw new Error(`Собранный пресет слишком слабый: ${quality.itemCount} директив(ы), ${quality.categoryCount} категорий.`);
    }

    return quality;
}

function getStructuredMasterGenerationSettings(master) {
    return {
        maxTokens: Math.max(Number(master?.maxTokens) || DEFAULT_MASTER_MAX_TOKENS, MASTER_STRUCTURED_MIN_TOKENS),
        temperature: Math.max(Number(master?.temperature) || DEFAULT_MASTER_TEMPERATURE, MASTER_STRUCTURED_MIN_TEMPERATURE),
    };
}

function getFallbackMasterGenerationSettings(master) {
    const baseMaxTokens = Number(master?.maxTokens) || DEFAULT_MASTER_MAX_TOKENS;
    const baseTemperature = Number(master?.temperature) || DEFAULT_MASTER_TEMPERATURE;

    return {
        maxTokens: Math.min(Math.max(baseMaxTokens, MASTER_FALLBACK_MAX_TOKENS), 480),
        temperature: Math.max(baseTemperature, MASTER_FALLBACK_MIN_TEMPERATURE),
    };
}

async function generateMasterCategoryFallback(connection, category, master, signal) {
    const sourceText = getResolvedMasterContext();
    if (!sourceText) {
        throw new Error(`Нет данных для категории ${category.label}.`);
    }

    const targetCount = MASTER_FALLBACK_CATEGORY_TARGETS[category.id] || 2;
    const collectedItems = [];
    const slotErrors = [];
    const fallbackSettings = getFallbackMasterGenerationSettings(master);

    for (let slotIndex = 0; slotIndex < targetCount; slotIndex++) {
        let slotItem = null;

        for (let attempt = 0; attempt < MASTER_FALLBACK_SLOT_RETRIES; attempt++) {
            const promptBundle = buildMasterCategoryRawMessages(category, {
                slotIndex,
                targetCount,
                existingItems: collectedItems,
            });
            const messages = [
                { role: 'system', content: promptBundle.systemPrompt },
                { role: 'user', content: promptBundle.userPrompt },
            ];

            let rawResponse;
            let backendError = null;
            let directError = null;

            try {
                rawResponse = await requestMasterPresetViaBackend({
                    url: connection.url,
                    apiKey: connection.apiKey,
                    model: connection.model,
                    messages,
                    maxTokens: fallbackSettings.maxTokens,
                    temperature: fallbackSettings.temperature,
                    signal,
                });
                const parsed = parseMasterLineResponse(rawResponse);
                slotItem = parsed.items.find((item) => item.category === category.id)
                    || parsed.items[0]
                    || null;
            } catch (error) {
                if (isAbortLikeError(error)) {
                    throw error;
                }
                backendError = error;
            }

            if (!slotItem) {
                try {
                    rawResponse = await requestMasterPresetDirect({
                        url: connection.url,
                        apiKey: connection.apiKey,
                        model: connection.model,
                        messages,
                        maxTokens: fallbackSettings.maxTokens,
                        temperature: fallbackSettings.temperature,
                        signal,
                    });
                    const parsed = parseMasterLineResponse(rawResponse);
                    slotItem = parsed.items.find((item) => item.category === category.id)
                        || parsed.items[0]
                        || null;
                } catch (error) {
                    if (isAbortLikeError(error)) {
                        throw error;
                    }
                    directError = error;
                }
            }

            if (slotItem) {
                const normalizedItem = normalizePresetItem(slotItem);
                const isDuplicate = collectedItems.some((item) => item.name.toLowerCase() === normalizedItem.name.toLowerCase());
                if (!isDuplicate) {
                    collectedItems.push(normalizedItem);
                    break;
                }

                slotErrors.push(`Дубликат в ${category.label}, слот ${slotIndex + 1}, попытка ${attempt + 1}: ${normalizedItem.name}`);
                slotItem = null;
                continue;
            }

            const backendMessage = backendError?.message ? `Backend raw: ${backendError.message}` : '';
            const directMessage = directError?.message ? `Direct raw: ${directError.message}` : '';
            slotErrors.push(`Слот ${slotIndex + 1}, попытка ${attempt + 1}: ${[backendMessage, directMessage].filter(Boolean).join(' | ') || 'пустой ответ'}`);
        }
    }

    if (collectedItems.length === 0) {
        throw new Error([`Не удалось собрать категорию ${category.label}.`, ...slotErrors].join(' | '));
    }

    return collectedItems;
}

function parseMasterPresetResponse(rawResponse) {
    let parsed = rawResponse;
    const rawText = typeof rawResponse === 'string' ? rawResponse : '';

    if (typeof parsed === 'string') {
        const cleaned = cleanupMarkdownFences(parsed);
        const candidates = [];
        const pushCandidate = (value) => {
            const text = String(value || '').trim();
            if (!text || candidates.includes(text)) {
                return;
            }
            candidates.push(text);
        };

        pushCandidate(extractBalancedSegment(cleaned, '{', '}'));
        pushCandidate(extractJsonCandidate(cleaned));
        pushCandidate(cleaned);

        let parseError = 'Unknown JSON parse error';
        let parsedObject = null;

        for (const candidate of candidates) {
            const preparedVariants = [
                candidate,
                repairJsonCandidate(candidate),
                repairLooseJsonCandidate(candidate),
            ].filter((value, index, array) => array.indexOf(value) === index);

            for (const prepared of preparedVariants) {
                try {
                    const maybeParsed = JSON.parse(prepared);
                    const normalized = normalizeMasterPresetPayload(maybeParsed);
                    if (normalized) {
                        parsedObject = maybeParsed;
                        break;
                    }
                    parseError = 'JSON разобран, но объект пресета не найден.';
                } catch (error) {
                    parseError = error?.message || 'Unknown JSON parse error';
                }
            }

            if (parsedObject) {
                break;
            }
        }

        if (!parsedObject) {
            const salvaged = salvagePartialMasterPreset(cleaned);
            if (salvaged) {
                parsedObject = salvaged;
            }
        }

        if (!parsedObject) {
            throw new Error(`Не удалось распарсить JSON ответа модели: ${parseError}`);
        }

        parsed = parsedObject;
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Модель вернула пустой или неверный ответ.');
    }

    const normalizedPayload = normalizeMasterPresetPayload(parsed);
    if (!normalizedPayload) {
        throw new Error('Модель вернула объект, но структура пресета не распознана.');
    }

    const directivesByName = new Map(getSettings().directives.map((directive) => [directive.name.toLowerCase(), directive]));

    const items = dedupePresetItems(
        normalizedPayload.directives
            .map((item) => normalizePresetItem(item, directivesByName))
            .filter(Boolean),
    );

    if (!items.length) {
        if (rawText) {
            const salvaged = salvagePartialMasterPreset(rawText);
            if (salvaged) {
                const salvagedPayload = normalizeMasterPresetPayload(salvaged);
                const salvagedItems = dedupePresetItems(
                    (salvagedPayload?.directives || [])
                        .map((item) => normalizePresetItem(item, directivesByName))
                        .filter(Boolean),
                );

                if (salvagedItems.length) {
                    return {
                        presetName: salvagedPayload.presetName,
                        partial: true,
                        categories: normalizeCategories(salvagedPayload.categories, salvagedItems, []),
                        items: salvagedItems,
                    };
                }
            }
        }

        throw new Error('Модель вернула ответ, но в нём нет пригодных директив. Похоже, ответ был обрезан или искажён ещё до парсинга.');
    }

    return {
        presetName: normalizedPayload.presetName,
        partial: Boolean(normalizedPayload.partial),
        categories: normalizeCategories(normalizedPayload.categories, items, []),
        items,
    };
}

async function generateMasterPreset() {
    if (state.masterGenerating) {
        notify('info', 'Сборка пресета уже идёт.');
        return;
    }

    const master = getSettings().masterPreset;
    const { sourceText, systemPrompt, userPrompt } = buildMasterMessages();
    if (!sourceText) {
        notify('warning', 'Не удалось собрать данные из макросов персонажа и персоны.');
        return;
    }

    let connection;
    try {
        connection = getMasterConnectionDetails();
    } catch (error) {
        notify('warning', error.message || 'Проверь параметры подключения.');
        return;
    }

    if (!connection.model) {
        notify('warning', 'Сначала выбери модель для генерации.');
        return;
    }

    const context = SillyTavern.getContext();
    const { controller, cleanup } = createTimedAbortController(
        MASTER_REQUEST_TIMEOUT_MS,
        'Сборка пресета заняла слишком много времени.',
    );
    state.masterAbortController = controller;

    const loaderHandle = context.loader?.show({
        message: 'Собираю пресет...',
        blocking: true,
        onStop: () => abortMasterGeneration('Отменено пользователем.'),
    });

    state.masterGenerating = true;
    renderMasterControls();

    let lastRawMasterResponse = null;

    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];
        const structuredSettings = getStructuredMasterGenerationSettings(master);
        const rawResponse = await requestMasterPresetDirect({
            url: connection.url,
            apiKey: connection.apiKey,
            model: connection.model,
            messages,
            maxTokens: structuredSettings.maxTokens,
            temperature: structuredSettings.temperature,
            signal: controller.signal,
        });
        lastRawMasterResponse = rawResponse;
        const parsed = parseMasterPresetResponse(rawResponse);
        validateMasterPresetQuality(parsed.items, { allowPartial: parsed.partial });

        applyPresetItems(parsed.items, {
            clearSelectedPreset: true,
            expandTouchedCategories: true,
            replaceCategories: Array.isArray(parsed.categories) && parsed.categories.length > 0,
            categories: parsed.categories,
        });

        master.lastPresetName = parsed.presetName;
        master.statusLevel = 'success';
        master.statusText = `Подключено. Активная модель: ${connection.model}.`;
        saveSettingsDebounced();

        renderPresetsDropdown();
        renderDirectorHud();
        renderMasterControls();
        updateDirectorPrompt();
        if (parsed.partial) {
            console.warn('[BB Scene Director] Master preset was partially recovered from a truncated response.');
        }
        notify('success', parsed.partial
            ? `Пресет "${parsed.presetName}" частично восстановлен и применён.`
            : `Пресет "${parsed.presetName}" собран и применён.`);
    } catch (error) {
        const aborted = isAbortLikeError(error);
        master.statusLevel = aborted ? 'idle' : 'error';
        master.statusText = aborted
            ? String(controller.signal.reason || error.message || 'Сборка пресета отменена.')
            : (error.message || 'Не удалось собрать пресет.');
        saveSettingsDebounced();
        renderMasterControls();
        if (lastRawMasterResponse) {
            console.warn('[BB Scene Director] Raw master response snippet:', describeMasterResponseSnippet(lastRawMasterResponse));
        }
        console.error('[BB Scene Director] Master preset generation failed.', error);
        notify(aborted ? 'info' : 'error', master.statusText);
    } finally {
        cleanup();
        state.masterAbortController = null;
        state.masterGenerating = false;
        renderMasterControls();

        if (loaderHandle?.hide) {
            await loaderHandle.hide();
        }
    }
}

function renderMasterControls() {
    const master = getSettings().masterPreset;
    const urlInput = $('#bb-dir-master-url');
    const apiInput = $('#bb-dir-master-api');
    const status = $('#bb-dir-master-status');
    const lastPreset = $('#bb-dir-master-last');
    const modelSelect = $('#bb-dir-master-model');
    const checkButton = $('#bb-dir-master-check');
    const generateButton = $('#bb-dir-master-generate');

    if (urlInput.length && urlInput.val() !== master.url) {
        urlInput.val(master.url);
    }

    if (apiInput.length && apiInput.val() !== master.apiKey) {
        apiInput.val(master.apiKey);
    }

    if (status.length) {
        status.removeClass('is-idle is-success is-error is-busy');

        if (state.masterChecking) {
            status.addClass('is-busy').text('Проверяю подключение и список моделей...');
        } else if (state.masterGenerating) {
            status.addClass('is-busy').text('Собираю пресет...');
        } else {
            const statusClass = master.statusLevel === 'success'
                ? 'is-success'
                : master.statusLevel === 'error'
                    ? 'is-error'
                    : 'is-idle';
            status.addClass(statusClass).text(master.statusText || 'Подключение не проверено.');
        }
    }

    if (lastPreset.length) {
        lastPreset.text(master.lastPresetName ? `Последний собранный пресет: ${master.lastPresetName}` : '');
        lastPreset.toggle(Boolean(master.lastPresetName));
    }

    if (modelSelect.length) {
        const models = Array.isArray(master.availableModels) ? master.availableModels : [];
        modelSelect.empty();
        modelSelect.attr('title', master.model || '');

        if (models.length) {
            models.forEach((modelId) => {
                modelSelect.append(`<option value="${escapeHtml(modelId)}">${escapeHtml(modelId)}</option>`);
            });

            let selectedChanged = false;
            if (!master.model || !models.includes(master.model)) {
                master.model = models[0];
                selectedChanged = true;
            }

            modelSelect.val(master.model);
            modelSelect.prop('disabled', false);

            if (selectedChanged) {
                saveSettingsDebounced();
            }
        } else if (master.model) {
            modelSelect.append(`<option value="${escapeHtml(master.model)}">${escapeHtml(master.model)}</option>`);
            modelSelect.val(master.model);
            modelSelect.prop('disabled', true);
        } else {
            modelSelect.append('<option value="">Сначала подключись</option>');
            modelSelect.val('');
            modelSelect.prop('disabled', true);
        }
    }

    if (checkButton.length) {
        checkButton.prop('disabled', state.masterChecking || state.masterGenerating || !normalizeBaseUrl(master.url));
    }

    if (generateButton.length) {
        const hasConnectedModels = Array.isArray(master.availableModels) && master.availableModels.length > 0;
        const canGenerate = !state.masterChecking
            && !state.masterGenerating
            && Boolean(normalizeBaseUrl(master.url))
            && Boolean(String(master.model || '').trim())
            && hasConnectedModels;

        generateButton.prop('disabled', !canGenerate);
    }

    return;
}

function setupExtensionSettings() {
    if (document.getElementById('bb-director-settings-wrapper')) {
        return;
    }

    const settings = getSettings();
    const settingsHtml = `
        <div id="bb-director-settings-wrapper" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>BB Scene Director</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content bb-dir-settings-panel">
                <label class="checkbox_label">
                    <input type="checkbox" id="bb-dir-cfg-usemacro" ${settings.useMacro ? 'checked' : ''}>
                    <span>Использовать макрос <code>{{bb_scene}}</code> вместо авто-вставки</span>
                </label>
                <div class="bb-dir-settings-note">
                    Если включить опцию, расширение перестанет само вставлять инструкцию в чат и будет только разворачивать <code>{{bb_scene}}</code> там, где ты его используешь вручную.
                </div>
                <div class="bb-dir-settings-master">
                    <div class="bb-dir-block-title">Подключение генератора пресета</div>
                    <div class="bb-dir-master-grid">
                        <label class="bb-dir-field bb-dir-field-wide">
                            <span>URL</span>
                            <input id="bb-dir-master-url" class="bb-dir-input" type="text" placeholder="Например: https://site.com/v1">
                        </label>
                        <label class="bb-dir-field">
                            <span>API-ключ</span>
                            <input id="bb-dir-master-api" class="bb-dir-input" type="password" placeholder="Токен или ключ доступа">
                        </label>
                        <label class="bb-dir-field">
                            <span>Модель</span>
                            <select id="bb-dir-master-model" class="bb-dir-input" disabled>
                                <option value="">Модели не загружены</option>
                            </select>
                        </label>
                    </div>
                    <div class="bb-dir-note">Используется отдельное подключение для сборки пресета. Основная модель чата не трогается.</div>
                    <div class="bb-dir-master-actions">
                        <button id="bb-dir-master-check" class="bb-dir-btn interactable bb-dir-with-icon">
                            <i class="fa-solid fa-plug"></i><span>Подключиться</span>
                        </button>
                    </div>
                    <div id="bb-dir-master-status" class="bb-dir-status is-idle"></div>
                    <div id="bb-dir-master-last" class="bb-dir-last" style="display:none;"></div>
                </div>
            </div>
        </div>
    `;

    const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (target) {
        target.insertAdjacentHTML('beforeend', settingsHtml);
    }

    $('#bb-dir-cfg-usemacro').on('change', function onUseMacroChange() {
        getSettings().useMacro = $(this).is(':checked');
        saveSettingsDebounced();
        updateDirectorPrompt();
    });

    $('#bb-dir-master-url').on('input', function onUrlInput() {
        getSettings().masterPreset.url = String($(this).val() || '');
        markMasterConnectionDirty({ clearModels: true });
    });

    $('#bb-dir-master-api').on('input', function onApiInput() {
        getSettings().masterPreset.apiKey = String($(this).val() || '');
        markMasterConnectionDirty({ clearModels: true });
    });

    $('#bb-dir-master-model').on('change', function onModelChange() {
        const value = String($(this).val() || '').trim();
        if (!value) {
            return;
        }

        getSettings().masterPreset.model = value;
        if (getSettings().masterPreset.statusLevel === 'success') {
            getSettings().masterPreset.statusText = `Подключено. Активная модель: ${value}.`;
        }
        saveSettingsDebounced();
        renderMasterControls();
    });

    $('#bb-dir-master-check').on('click', function onMasterCheck() {
        void checkMasterConnection();
    });
}

function ensureDirectorHud() {
    if (document.getElementById('bb-director-hud')) {
        return;
    }

    const hudHtml = `
        <div id="bb-director-toggle" title="Scene Director">
            <i class="fa-solid fa-clapperboard"></i>
            <i class="fa-solid fa-chevron-right" id="bb-dir-arrow"></i>
        </div>
        <aside id="bb-director-hud">
            <div class="bb-dir-head">
                <div class="bb-dir-kicker">BB Scene Director</div>
                <div class="bb-dir-title">Scene Director</div>
                <div class="bb-dir-subtitle">Компактная режиссура сцены: фокус, динамика, сюжет и акценты</div>
            </div>

            <div class="bb-dir-toolbar">
                <div class="bb-dir-block">
                    <div class="bb-dir-block-title">Пресеты</div>
                    <select id="bb-dir-preset-select" class="bb-dir-input"></select>
                    <div class="bb-dir-preset-actions">
                        <button id="bb-dir-load-preset" class="bb-dir-btn interactable" title="Загрузить"><i class="fa-solid fa-download"></i></button>
                        <button id="bb-dir-update-preset" class="bb-dir-btn interactable" title="Перезаписать"><i class="fa-solid fa-floppy-disk"></i></button>
                        <button id="bb-dir-save-new-preset" class="bb-dir-btn interactable" title="Сохранить как новый"><i class="fa-solid fa-file-circle-plus"></i></button>
                        <button id="bb-dir-rename-preset" class="bb-dir-btn interactable" title="Переименовать"><i class="fa-solid fa-pen"></i></button>
                        <button id="bb-dir-del-preset" class="bb-dir-btn interactable bb-dir-danger" title="Удалить"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <div class="bb-dir-preset-io">
                        <button id="bb-dir-import-json" class="bb-dir-btn interactable bb-dir-with-icon" title="Импортировать JSON-пресет">
                            <i class="fa-solid fa-file-import"></i><span>Импорт JSON</span>
                        </button>
                        <button id="bb-dir-export-json" class="bb-dir-btn interactable bb-dir-with-icon" title="Экспортировать пресет в JSON">
                            <i class="fa-solid fa-file-export"></i><span>Экспорт JSON</span>
                        </button>
                    </div>
                    <div class="bb-dir-master-actions">
                        <button id="bb-dir-master-generate" class="bb-dir-btn interactable bb-dir-with-icon">
                            <i class="fa-solid fa-wand-magic-sparkles"></i><span>Собрать пресет</span>
                        </button>
                    </div>
                </div>
            </div>

            <div id="bb-dir-list"></div>

            <div class="bb-dir-footer">
                <div class="bb-dir-footer-actions">
                    <button id="bb-dir-add-btn" class="bb-dir-btn interactable bb-dir-with-icon"><i class="fa-solid fa-folder-plus"></i><span>Добавить категорию</span></button>
                    <button id="bb-dir-stealth-btn" class="bb-dir-btn interactable bb-dir-with-icon" title="Скрывать неактивные"><i class="fa-solid fa-eye-slash"></i><span>Скрыть неактивные</span></button>
                    <button id="bb-dir-preview-toggle" class="bb-dir-btn interactable bb-dir-with-icon"><i class="fa-solid fa-eye"></i><span>Показать инструкцию</span></button>
                </div>
                <div id="bb-dir-preview-wrap" class="bb-dir-preview-wrap" hidden>
                    <div class="bb-dir-block-title">Текущая инструкция</div>
                    <div id="bb-dir-preview-text"></div>
                </div>
            </div>
        </aside>
    `;

    $('body').append(hudHtml);

    $('#bb-director-toggle').on('click', function onToggleClick() {
        const hud = $('#bb-director-hud');
        const toggle = $('#bb-director-toggle');

        hud.toggleClass('open');
        toggle.toggleClass('is-open', hud.hasClass('open'));

        if (hud.hasClass('open')) {
            $('#bb-dir-arrow').removeClass('fa-chevron-right').addClass('fa-chevron-left');
        } else {
            $('#bb-dir-arrow').removeClass('fa-chevron-left').addClass('fa-chevron-right');
        }
    });

    $('#bb-dir-list')
        .on('click', '.bb-dir-section-toggle', function onSectionToggle() {
            const categoryId = normalizeCategoryId(String($(this).data('categoryId') || ''), getSettings().categories);
            const currentState = normalizeExpandedCategories(getSettings().expandedCategories, getSettings().categories);
            ensureCategoryExpansionState(categoryId, !currentState[categoryId]);
            saveSettingsDebounced();
            renderDirectorHud();
        })
        .on('input', '.bb-dir-slider', function onSliderInput() {
            const directive = findDirectiveByCard(this);
            if (!directive) {
                return;
            }

            directive.value = snapDirectiveValue($(this).val());
            const card = $(this).closest('.bb-dir-card');
            card.find('.bb-dir-slider-value').text(`${directive.value}%`);
            card.find('.bb-dir-level-pill').text(getIntensityLabel(directive.value));
            saveSettingsDebounced();
            schedulePromptUpdate();
        })
        .on('click', '.bb-dir-toggle', function onToggleDirective() {
            const directive = findDirectiveByCard(this);
            if (!directive) {
                return;
            }

            directive.active = !directive.active;
            saveSettingsDebounced();
            renderDirectorHud();
            updateDirectorPrompt();
        })
        .on('click', '.bb-dir-delete', function onDeleteDirective() {
            const directive = findDirectiveByCard(this);
            if (!directive) {
                return;
            }

            getSettings().directives = getSettings().directives.filter((item) => item.id !== directive.id);
            saveSettingsDebounced();
            renderDirectorHud();
            updateDirectorPrompt();
        })
        .on('change', '.bb-dir-name', function onDirectiveRename() {
            const directive = findDirectiveByCard(this);
            if (!directive) {
                return;
            }

            directive.name = String($(this).val() || '').trim() || 'Новая директива';
            saveSettingsDebounced();
            updateDirectorPrompt();
        })
        .on('change', '.bb-dir-category-select', function onCategoryChange() {
            const directive = findDirectiveByCard(this);
            if (!directive) {
                return;
            }

            directive.category = normalizeCategoryId($(this).val(), getSettings().categories);
            ensureCategoryExpansionState(directive.category, true);
            state.revealDirectiveId = directive.id;
            saveSettingsDebounced();
            renderDirectorHud();
            updateDirectorPrompt();
        })
        .on('click', '.bb-dir-section-add', function onSectionAdd() {
            const categoryId = normalizeCategoryId(String($(this).data('categoryId') || ''), getSettings().categories);
            const directive = createDirective({
                category: categoryId,
                name: 'Новая директива',
                value: 50,
                active: true,
            });
            getSettings().directives.push(directive);
            ensureCategoryExpansionState(categoryId, true);
            state.revealDirectiveId = directive.id;

            saveSettingsDebounced();
            renderDirectorHud();
            updateDirectorPrompt();
        })
        .on('click', '.bb-dir-section-delete', function onSectionDelete() {
            const categoryId = String($(this).data('categoryId') || '').trim();
            if (!categoryId) {
                return;
            }

            void handleDeleteCategory(categoryId);
        });

    $('#bb-dir-add-btn').on('click', async function onAddCategoryClick() {
        const name = await promptText('Название новой категории:', '', {
            okButton: 'Дальше',
            cancelButton: 'Отмена',
        });

        if (!name || !name.trim()) {
            return;
        }

        const label = name.trim();
        const draftCategory = createCategoryRecord({
            id: label,
            label,
            promptLabel: label,
        }, getCategories().length);

        if (getCategories().some((category) => category.id === draftCategory.id)) {
            ensureCategoryExpansionState(draftCategory.id, true);
            saveSettingsDebounced();
            renderDirectorHud();
            notify('info', `Категория "${draftCategory.label}" уже существует.`);
            return;
        }

        const hint = await promptText('Короткое описание категории (необязательно):', '', {
            okButton: 'Создать',
            cancelButton: 'Пропустить',
        });

        ensureCategoriesExist([{
            ...draftCategory,
            hint: String(hint || '').trim(),
        }]);
        ensureCategoryExpansionState(draftCategory.id, true);
        saveSettingsDebounced();
        renderDirectorHud();
        updateDirectorPrompt();
        notify('success', `Категория "${draftCategory.label}" добавлена.`);
    });

    $('#bb-dir-load-preset').on('click', handleLoadPreset);
    $('#bb-dir-update-preset').on('click', function onUpdateClick() {
        void handleUpdatePreset(this);
    });
    $('#bb-dir-save-new-preset').on('click', function onSavePresetClick() {
        void handleSaveNewPreset();
    });
    $('#bb-dir-rename-preset').on('click', function onRenamePresetClick() {
        void handleRenamePreset();
    });
    $('#bb-dir-del-preset').on('click', function onDeletePresetClick() {
        void handleDeletePreset();
    });
    $('#bb-dir-export-json').on('click', function onExportPresetClick() {
        void handleExportPreset();
    });
    $('#bb-dir-import-json').on('click', function onImportPresetClick() {
        const input = createImportFileInput();
        input.value = '';
        input.click();
    });

    createImportFileInput().addEventListener('change', (event) => {
        const target = event.target;
        const file = target instanceof HTMLInputElement ? target.files?.[0] : null;
        void handleImportPresetFile(file);
    });

    $('#bb-dir-stealth-btn').on('click', function onStealthClick() {
        getSettings().hideInactive = !getSettings().hideInactive;
        saveSettingsDebounced();
        renderDirectorHud();
    });

    $('#bb-dir-preview-toggle').on('click', function onPreviewToggle() {
        getSettings().previewExpanded = !getSettings().previewExpanded;
        saveSettingsDebounced();
        renderPreviewToggleState();
    });

    $('#bb-dir-master-generate').on('click', function onGenerateMaster() {
        void generateMasterPreset();
    });

    renderPresetsDropdown();
    renderDirectorHud();
    renderMasterControls();
    updateDirectorPrompt();
}

function toggleHudVisibility() {
    const context = SillyTavern.getContext();
    const toggleButton = $('#bb-director-toggle');
    const hud = $('#bb-director-hud');

    if (context.chatId) {
        toggleButton.show();
        return;
    }

    toggleButton.hide();
    if (hud.hasClass('open')) {
        hud.removeClass('open');
        toggleButton.removeClass('is-open');
        $('#bb-dir-arrow').removeClass('fa-chevron-left').addClass('fa-chevron-right');
    }
}

function updateHudTopOffset() {
    const candidates = [
        '#top-bar',
        '.top-bar',
        '#top_settings',
        '#navigation',
        '.drawer-content .top',
    ];

    let maxBottom = 0;
    for (const selector of candidates) {
        const element = document.querySelector(selector);
        if (!element) {
            continue;
        }

        const rect = element.getBoundingClientRect();
        if (rect.bottom > maxBottom) {
            maxBottom = rect.bottom;
        }
    }

    document.documentElement.style.setProperty('--bb-dir-offset-top', `${Math.max(0, Math.round(maxBottom))}px`);
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
