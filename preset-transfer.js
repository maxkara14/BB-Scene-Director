import {
    PRESET_FILE_FORMAT,
    PRESET_FILE_VERSION,
    parsePresetImportText,
    sanitizePresetFilename,
    stringifyPresetFile,
} from './preset-storage.js';

export function createPresetTransferController({
    dedupePresetItems,
    getCategories,
    getCurrentDraftItems,
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
    setSelectedPresetIndex,
}) {
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
        const items = getCurrentDraftItems();
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
                setSelectedPresetIndex(importedIndex);
            }
            notify('success', `Импортирован пресет "${imported[0].name}".`);
            return;
        }

        notify('success', `Импортировано пресетов: ${imported.length}.`);
    }

    return {
        cloneJson,
        createImportFileInput,
        createPresetRecord,
        getCurrentDraftPresetSnapshot,
        getExportPresetSnapshot,
        handleExportPreset,
        handleImportPresetFile,
        importRawPresets,
    };
}
