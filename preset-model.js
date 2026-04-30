import { PRESET_FILE_FORMAT, PRESET_FILE_VERSION } from './preset-storage.js';

export const DEFAULT_CATEGORY_TEMPLATES = [
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

export function createCategoryFromTemplate(template) {
    return {
        id: template.id,
        label: template.label,
        promptLabel: template.promptLabel,
        hint: template.hint,
    };
}

export function getDefaultCategories() {
    return DEFAULT_CATEGORY_TEMPLATES.map((category) => createCategoryFromTemplate(category));
}

export function getFallbackCategoryId(categories = getDefaultCategories()) {
    return categories[0]?.id || DEFAULT_CATEGORY_TEMPLATES[0].id;
}

export function slugifyCategoryId(value) {
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

export function humanizeCategoryId(categoryId) {
    const raw = String(categoryId || '').trim();
    if (!raw) {
        return 'Новая категория';
    }

    const withSpaces = raw.replace(/[-_]+/g, ' ').trim();
    return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

export function createCategoryRecord(raw = {}, index = 0) {
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

function collectReferencedCategoryIds(directives = [], presets = [], categories = getDefaultCategories()) {
    const ids = new Set();
    const addValue = (value) => {
        if (typeof value !== 'string' || !value.trim()) {
            return;
        }
        const normalized = normalizeCategoryId(value, categories);
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

export function normalizeCategories(rawCategories, directives = [], presets = [], fallbackCategories = getDefaultCategories()) {
    const source = Array.isArray(rawCategories) ? rawCategories : [];
    const normalized = [];
    const seen = new Set();
    const fallback = Array.isArray(fallbackCategories) && fallbackCategories.length ? fallbackCategories : getDefaultCategories();

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
        fallback.forEach(pushCategory);
    }

    const referencedIds = collectReferencedCategoryIds(directives, presets, normalized.length ? normalized : fallback);
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

export function createDefaultExpandedCategories(categories = getDefaultCategories()) {
    return Object.fromEntries(categories.map((category) => [category.id, false]));
}

export function makeId(prefix = 'bbdir') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function snapDirectiveValue(value) {
    let numeric = Number(value);

    if (typeof value === 'string') {
        const match = value.match(/-?\d+(?:[.,]\d+)?/);
        numeric = match ? Number(match[0].replace(',', '.')) : Number.NaN;
    }

    if (!Number.isFinite(numeric)) {
        return 50;
    }

    return clamp(Math.round(numeric / 5) * 5, 0, 100);
}

export function normalizeCategoryId(value, categories = getDefaultCategories()) {
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

export function guessDirectiveCategory(name, categories = getDefaultCategories()) {
    const normalized = String(name || '').trim().toLowerCase();

    if (!normalized) {
        return getFallbackCategoryId(categories);
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

    return getFallbackCategoryId(categories);
}

export function createDirective(raw = {}, categories = getDefaultCategories()) {
    return {
        id: String(raw.id || makeId('dir')),
        name: String(raw.name || 'Новая директива').trim() || 'Новая директива',
        value: snapDirectiveValue(raw.value),
        active: Boolean(raw.active),
        category: normalizeCategoryId(raw.category || guessDirectiveCategory(raw.name, categories), categories),
    };
}

export function normalizeDirectives(rawDirectives = [], categories = getDefaultCategories()) {
    const directives = [];
    const seenIds = new Set();

    rawDirectives.forEach((directive) => {
        if (!directive || typeof directive !== 'object') {
            return;
        }

        const normalized = createDirective(directive, categories);
        if (seenIds.has(normalized.id)) {
            normalized.id = makeId('dir');
        }

        seenIds.add(normalized.id);
        directives.push(normalized);
    });

    return directives;
}

export function normalizeExpandedCategories(raw, categories = getDefaultCategories()) {
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

export function createPresetItemFromDirective(directive) {
    return {
        directiveId: String(directive.id),
        name: directive.name,
        category: directive.category,
        value: directive.value,
        active: directive.active !== false,
    };
}

export function normalizePresetItem(raw, directivesByName = new Map(), categories = getDefaultCategories()) {
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
        category: normalizeCategoryId(raw.category || directiveByName?.category || guessDirectiveCategory(name, categories), categories),
        value: snapDirectiveValue(raw.value),
        active: raw.active !== false,
    };
}

export function dedupePresetItems(items) {
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

export function normalizePreset(rawPreset, directives = [], categories = getDefaultCategories()) {
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

    const sourceCategories = normalizeCategories(rawPreset.categories, sourceItems, [], categories);

    const items = dedupePresetItems(
        sourceItems
            .map((item) => normalizePresetItem(item, directivesByName, sourceCategories))
            .filter(Boolean),
    );

    return {
        id: String(rawPreset.id || makeId('preset')),
        name: String(rawPreset.name || 'Без названия').trim() || 'Без названия',
        items,
        categories: normalizeCategories(sourceCategories, items, [], categories),
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

export function normalizePresets(rawPresets = [], directives = [], categories = getDefaultCategories()) {
    const presets = [];
    const seenIds = new Set();

    rawPresets.forEach((preset) => {
        const normalized = normalizePreset(preset, directives, categories);
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
