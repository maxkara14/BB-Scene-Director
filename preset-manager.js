export function createPresetManager({
    applyExpandedCategoriesFromItems,
    confirmAction,
    createDirective,
    createPresetItemFromDirective,
    createPresetRecord,
    draftState,
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
        draftState.checkpoint();
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
                        description: item.description,
                        category: item.category,
                        value: item.value,
                        active: item.active,
                        locked: item.locked,
                    });
                } else {
                    directive = {
                        ...directive,
                        name: item.name,
                        description: item.description,
                        category: item.category,
                        value: item.value,
                        active: item.active !== false,
                        locked: item.locked === true,
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
        if (Number.isInteger(options.presetIndex)) {
            settings.lastActivePreset = options.presetIndex;
        }
    }

    function isDraftUnchanged(signature) {
        if (draftState.getSignature() === signature) {
            return true;
        }
        notify('warning', 'Чат или сцена изменились, пока был открыт диалог. Повтори действие для текущей сцены.');
        return false;
    }

    async function confirmDraftReplacement() {
        if (!draftState.getStatus().dirty) {
            return true;
        }
        const signature = draftState.getSignature();
        const confirmed = await confirmAction(
            'В текущей сцене есть изменения, не сохранённые в пресет. Заменить её? Предыдущее состояние можно вернуть кнопкой «Отменить» до перезагрузки страницы.',
            { okButton: 'Заменить', cancelButton: 'Оставить сцену' },
        );
        return confirmed && isDraftUnchanged(signature);
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

        if (!await confirmDraftReplacement()) {
            return;
        }

        applyPresetItems(preset.items, {
            expandTouchedCategories: true,
            replaceCategories: Array.isArray(preset.categories) && preset.categories.length > 0,
            categories: preset.categories,
            presetIndex: index,
        });
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

        const signature = draftState.getSignature();
        const confirmed = await confirmAction(
            `Перезаписать пресет "${preset.name}" текущим деревом категорий и директив?`,
            { okButton: 'Перезаписать', cancelButton: 'Отмена' },
        );

        if (!confirmed || !isDraftUnchanged(signature)) {
            return;
        }

        preset.items = captureCurrentPresetItems();
        preset.categories = normalizeCategories(getCategories(), preset.items, []);
        saveSettingsDebounced();
        updateDirectorPrompt();
        flashButton(button);
        notify('success', `Пресет "${preset.name}" обновлён.`);
    }

    async function handleSaveNewPreset() {
        const signature = draftState.getSignature();
        const name = await promptText('Название нового пресета:', '', {
            okButton: 'Сохранить',
            cancelButton: 'Отмена',
        });

        if (!name || !name.trim() || !isDraftUnchanged(signature)) {
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
        updateDirectorPrompt();
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
        updateDirectorPrompt();
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
        updateDirectorPrompt();
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
        const signature = draftState.getSignature();
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

        if (!confirmed || !isDraftUnchanged(signature)) {
            return;
        }

        draftState.checkpoint();
        settings.directives = settings.directives.filter((directive) => directive.category !== normalizedId);
        settings.categories = settings.categories.filter((item) => item.id !== normalizedId);
        settings.expandedCategories = normalizeExpandedCategories(settings.expandedCategories, settings.categories);

        saveSettingsDebounced();
        renderPresetsDropdown();
        renderDirectorHud();
        updateDirectorPrompt();
        notify('success', `Категория "${category.label}" удалена.`);
    }

    function saveGeneratedPreset({ presetName, items, categories, partial = false, select = true }) {
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
        if (select) {
            getSettings().lastActivePreset = presetIndex;
            setSelectedPresetIndex(presetIndex);
        }

        return {
            preset,
            index: presetIndex,
        };
    }

    return {
        applyPresetItems,
        captureCurrentPresetItems,
        confirmDraftReplacement,
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
