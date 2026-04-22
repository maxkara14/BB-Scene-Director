export const PRESET_FILE_FORMAT = 'bb-scene-director-preset';
export const PRESET_FILE_VERSION = 1;

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPresetLike(value) {
    if (!isObject(value)) {
        return false;
    }

    return typeof value.name === 'string'
        || typeof value.presetName === 'string'
        || Array.isArray(value.items)
        || Array.isArray(value.directives)
        || Array.isArray(value.smartStyles)
        || Array.isArray(value.categories);
}

function unwrapPresetCollection(parsed) {
    if (!isObject(parsed) && !Array.isArray(parsed)) {
        return [];
    }

    if (Array.isArray(parsed)) {
        return parsed.filter(isPresetLike);
    }

    if (parsed.format === PRESET_FILE_FORMAT) {
        if (Array.isArray(parsed.presets)) {
            return parsed.presets.filter(isPresetLike);
        }

        if (isPresetLike(parsed.preset)) {
            return [parsed.preset];
        }
    }

    if (Array.isArray(parsed.presets)) {
        return parsed.presets.filter(isPresetLike);
    }

    if (isPresetLike(parsed.preset)) {
        return [parsed.preset];
    }

    const nestedSettings = parsed.extension_settings?.['BB-Scene-Director'];
    if (nestedSettings && Array.isArray(nestedSettings.presets)) {
        return nestedSettings.presets.filter(isPresetLike);
    }

    const directSettings = parsed['BB-Scene-Director'];
    if (directSettings && Array.isArray(directSettings.presets)) {
        return directSettings.presets.filter(isPresetLike);
    }

    if (isPresetLike(parsed)) {
        return [parsed];
    }

    return [];
}

export function sanitizePresetFilename(name, fallback = 'scene-director-preset') {
    const normalized = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

    return normalized || fallback;
}

export function createPresetFilePayload(preset, options = {}) {
    const exportedAt = options.exportedAt || new Date().toISOString();

    return {
        format: PRESET_FILE_FORMAT,
        version: PRESET_FILE_VERSION,
        exportedAt,
        preset: cloneJson(preset),
    };
}

export function stringifyPresetFile(preset, options = {}) {
    return JSON.stringify(createPresetFilePayload(preset, options), null, 2);
}

export function parsePresetImportText(rawText) {
    const parsed = JSON.parse(String(rawText || ''));
    const presets = unwrapPresetCollection(parsed).map((preset) => cloneJson(preset));

    return {
        format: isObject(parsed) && typeof parsed.format === 'string' ? parsed.format : '',
        version: isObject(parsed) && Number.isInteger(parsed.version) ? parsed.version : null,
        presets,
    };
}
