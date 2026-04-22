export function createPresetManager({
    applyExpandedCategoriesFromItems,
    confirmAction,
    createDirective,
    createPresetItemFromDirective,
    createPresetRecord,
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
    setSelectedPresetIndex,
    updateDirectorPrompt,
}) {
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
        setSelectedPresetIndex(getSettings().lastActivePreset);
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
        setSelectedPresetIndex(index);
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
        const categories = getCategories();
        const normalizedId = normalizeCategoryId(categoryId, categories);
        const directiveCount = getSettings().directives.filter((directive) => directive.category === normalizedId).length;
        const presetRefs = getSettings().presets.reduce((count, preset) => {
            const items = Array.isArray(preset?.items) ? preset.items : [];
            return count + items.filter((item) => normalizeCategoryId(item?.category, categories) === normalizedId).length;
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

    function saveGeneratedPreset({ presetName, items, categories, partial = false }) {
        const uniqueName = getUniquePresetName(
            String(presetName || '').trim() || 'Собранный пресет',
            getSettings().presets,
        );
        const preset = createPresetRecord(uniqueName, items, {
            generated: true,
            categories: Array.isArray(categories) && categories.length ? categories : getCategories(),
            summary: partial ? 'Частично восстановлен после обрезанного ответа модели.' : '',
        });

        getSettings().presets.push(preset);
        const presetIndex = getSettings().presets.length - 1;
        getSettings().lastActivePreset = presetIndex;
        setSelectedPresetIndex(presetIndex);

        return {
            preset,
            index: presetIndex,
        };
    }

    return {
        applyPresetItems,
        captureCurrentPresetItems,
        getCategoryUsageSnapshot,
        getReplacementCategoryId,
        handleDeleteCategory,
        handleDeletePreset,
        handleLoadPreset,
        handleRenamePreset,
        handleSaveNewPreset,
        handleUpdatePreset,
        saveGeneratedPreset,
    };
}
