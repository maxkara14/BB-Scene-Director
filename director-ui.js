export function createSceneDirectorUiController({
    createCategoryRecord,
    createDirective,
    ensureCategoriesExist,
    ensureCategoryExpansionState,
    escapeHtml,
    getCategories,
    getContext,
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
}) {
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

    function updatePauseButtonState() {
        const button = $('#bb-dir-pause-btn');
        if (!button.length) {
            return;
        }

        const isPaused = Boolean(getSettings().paused);
        const icon = isPaused ? 'fa-circle-play' : 'fa-circle-pause';
        const label = isPaused ? 'Пауза' : 'Активен';
        const title = isPaused
            ? 'Scene Director на паузе. Нажми, чтобы включить.'
            : 'Scene Director активен. Нажми, чтобы временно отключить.';

        button.toggleClass('is-active', !isPaused);
        button.toggleClass('is-paused', isPaused);
        button.attr('title', title);
        button.attr('aria-pressed', isPaused ? 'true' : 'false');
        button.html(`<i class="fa-solid ${icon}"></i><span>${escapeHtml(label)}</span>`);
    }

    function renderToolbarCollapsedState() {
        const settings = getSettings();
        const block = $('#bb-director-hud').find('.bb-dir-toolbar .bb-dir-block');
        const toggle = $('#bb-dir-toolbar-toggle');
        const body = $('#bb-dir-toolbar-body');
        const isCollapsed = Boolean(settings.toolbarCollapsed);

        block.toggleClass('is-collapsed', isCollapsed);
        toggle.attr('aria-expanded', isCollapsed ? 'false' : 'true');
        body.attr('aria-hidden', isCollapsed ? 'true' : 'false');
    }

    function renderFooterCollapsedState() {
        const settings = getSettings();
        const footer = $('#bb-dir-footer');
        const toggle = $('#bb-dir-footer-toggle');
        const body = $('#bb-dir-footer-body');
        const isCollapsed = Boolean(settings.footerCollapsed);

        footer.toggleClass('is-collapsed', isCollapsed);
        toggle.attr('aria-expanded', isCollapsed ? 'false' : 'true');
        body.attr('aria-hidden', isCollapsed ? 'true' : 'false');
    }

    function renderPreviewToggleState() {
        const settings = getSettings();
        const toggleButton = $('#bb-dir-preview-toggle');
        const previewWrap = $('#bb-dir-preview-wrap');
        const isExpanded = Boolean(settings.previewExpanded);
        const icon = isExpanded ? 'fa-eye-slash' : 'fa-eye';
        const label = isExpanded ? 'Скрыть промпт' : 'Показать промпт';

        if (toggleButton.length) {
            toggleButton.toggleClass('is-active', isExpanded);
            toggleButton.html(`<i class="fa-solid ${icon}"></i><span>${escapeHtml(label)}</span>`);
        }

        if (previewWrap.length) {
            previewWrap.toggleClass('is-open', isExpanded);
            previewWrap.toggleClass('is-closed', !isExpanded);
            previewWrap.attr('aria-hidden', isExpanded ? 'false' : 'true');
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
            '<span class="bb-dir-section-arrow"><i class="fa-solid fa-chevron-down"></i></span>',
                '</button>',
                '<div class="bb-dir-section-actions">',
                `<button class="bb-dir-btn interactable bb-dir-section-add" data-category-id="${escapeHtml(category.id)}" title="Добавить в секцию"><i class="fa-solid fa-plus"></i></button>`,
            `<button class="bb-dir-btn interactable bb-dir-section-delete${canDeleteCategory ? '' : ' is-disabled'}" data-category-id="${escapeHtml(category.id)}" title="Удалить категорию"${canDeleteCategory ? '' : ' disabled'}><i class="fa-solid fa-trash"></i></button>`,
            '</div>',
            '</div>',
            `<div class="bb-dir-section-list ${isExpanded ? 'is-open' : 'is-closed'}" data-category-id="${escapeHtml(category.id)}" aria-hidden="${isExpanded ? 'false' : 'true'}">`,
            '<div class="bb-dir-section-list-inner">',
            cards,
            emptyState,
            '</div>',
            '</div>',
            '</section>',
        ].join('');
        }).join('');

        root.html(sections);

        updateStealthButtonState();
        updatePauseButtonState();
        renderPreviewToggleState();
        requestAnimationFrame(revealDirectiveCardIfNeeded);
    }

    function markMasterConnectionDirty(options = {}) {
        const { clearModels = false } = options;
        const master = getSettings().masterPreset;
        master.statusLevel = 'idle';
        master.statusText = 'Параметры изменились. Нажми «Подключиться», чтобы обновить статус генератора.';

        if (clearModels) {
            master.availableModels = [];
        }

        saveSettingsDebounced();
        renderMasterControls();
    }

    function getMasterConnectionMode(master = getSettings().masterPreset) {
        return ['main', 'profile', 'custom'].includes(master.connectionMode) ? master.connectionMode : 'main';
    }

    function buildMasterProfileOptionsHtml(selectedProfileId = '') {
        const selected = String(selectedProfileId || '').trim();
        const profiles = typeof masterWorkflow.getSupportedMasterProfiles === 'function'
            ? masterWorkflow.getSupportedMasterProfiles()
            : [];
        const hasSelectedProfile = selected && profiles.some((profile) => profile.id === selected);
        const options = ['<option value="">Выбрать профиль...</option>'];

        if (selected && !hasSelectedProfile) {
            const label = typeof masterWorkflow.getMasterProfileLabel === 'function'
                ? masterWorkflow.getMasterProfileLabel(selected)
                : '';
            options.push(`<option value="${escapeHtml(selected)}" selected>Недоступный профиль: ${escapeHtml(label || selected)}</option>`);
        }

        profiles.forEach((profile) => {
            const label = profile.model
                ? `${profile.name || profile.id} (${profile.model})`
                : (profile.name || profile.id);
            const selectedAttr = profile.id === selected ? ' selected' : '';
            options.push(`<option value="${escapeHtml(profile.id)}"${selectedAttr}>${escapeHtml(label)}</option>`);
        });

        return options.join('');
    }

    function renderMasterControls() {
        const master = getSettings().masterPreset;
        const availability = masterWorkflow.getGenerationAvailability();
        const mode = getMasterConnectionMode(master);
        const modeSelect = $('#bb-dir-master-mode');
        const profileSelect = $('#bb-dir-master-profile');
        const profileField = $('#bb-dir-master-profile-field');
        const customFields = $('.bb-dir-master-custom-field');
        const urlInput = $('#bb-dir-master-url');
        const apiInput = $('#bb-dir-master-api');
        const status = $('#bb-dir-master-status');
        const lastPreset = $('#bb-dir-master-last');
        const modelSelect = $('#bb-dir-master-model');
        const checkButton = $('#bb-dir-master-check');
        const generateButton = $('#bb-dir-master-generate');

        if (modeSelect.length && modeSelect.val() !== mode) {
            modeSelect.val(mode);
        }

        if (profileSelect.length) {
            profileSelect.html(buildMasterProfileOptionsHtml(master.tavernProfileId));
            profileSelect.val(master.tavernProfileId || '');
        }

        profileField.toggle(mode === 'profile');
        customFields.toggle(mode === 'custom');

        if (urlInput.length && urlInput.val() !== master.url) {
            urlInput.val(master.url);
        }

        if (apiInput.length && apiInput.val() !== master.apiKey) {
            apiInput.val(master.apiKey);
        }

        if (status.length) {
            status.removeClass('is-idle is-success is-error is-busy');

            if (state.masterChecking) {
                status.addClass('is-busy').text('Проверяю подключение...');
            } else if (state.masterGenerating) {
                status.addClass('is-busy').text('Собираю пресет...');
            } else if (master.statusLevel === 'idle' && availability.label) {
                status.addClass('is-idle').text(`Для генерации будет использовано: ${availability.label}.`);
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

            if (mode !== 'custom') {
                const label = availability.model || 'Модель берётся из выбранного источника';
                modelSelect.append(`<option value="${escapeHtml(availability.model || '')}">${escapeHtml(label)}</option>`);
                modelSelect.val(availability.model || '');
                modelSelect.prop('disabled', true);
            } else if (models.length) {
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
            const canCheck = mode === 'main'
                || (mode === 'profile' && Boolean(master.tavernProfileId))
                || (mode === 'custom' && Boolean(normalizeBaseUrl(master.url)));
            checkButton.prop('disabled', state.masterChecking || state.masterGenerating || !canCheck);
        }

        if (generateButton.length) {
            const canGenerate = !state.masterChecking
                && !state.masterGenerating
                && availability.available;

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
                    <b>🎥 BB Scene Director</b>
                    <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content bb-dir-settings-panel">
                    <label class="checkbox_label">
                        <input type="checkbox" id="bb-dir-cfg-usemacro" ${settings.useMacro ? 'checked' : ''}>
                        <span>Использовать макрос <code>{{bb_scene}}</code> вместо авто-вставки</span>
                    </label>
                    <div class="bb-dir-settings-note">
                        Если включить опцию, расширение перестанет само вставлять промпт в чат и будет только разворачивать <code>{{bb_scene}}</code> там, где ты его используешь вручную.
                    </div>
                    <div class="bb-dir-settings-master">
                        <div class="bb-dir-block-title">Подключение генератора пресета</div>
                        <div class="bb-dir-master-grid">
                            <label class="bb-dir-field bb-dir-field-wide">
                                <span>Источник</span>
                                <select id="bb-dir-master-mode" class="bb-dir-input">
                                    <option value="main" ${getMasterConnectionMode(settings.masterPreset) === 'main' ? 'selected' : ''}>Текущие настройки SillyTavern</option>
                                    <option value="profile" ${getMasterConnectionMode(settings.masterPreset) === 'profile' ? 'selected' : ''}>Сохранённый профиль SillyTavern</option>
                                    <option value="custom" ${getMasterConnectionMode(settings.masterPreset) === 'custom' ? 'selected' : ''}>Custom OpenAI-compatible API</option>
                                </select>
                            </label>
                            <label id="bb-dir-master-profile-field" class="bb-dir-field bb-dir-field-wide">
                                <span>Профиль SillyTavern</span>
                                <select id="bb-dir-master-profile" class="bb-dir-input">
                                    ${buildMasterProfileOptionsHtml(settings.masterPreset.tavernProfileId)}
                                </select>
                            </label>
                            <label class="bb-dir-field bb-dir-field-wide bb-dir-master-custom-field">
                                <span>URL</span>
                                <input id="bb-dir-master-url" class="bb-dir-input" type="text" placeholder="Например: https://site.com/v1">
                            </label>
                            <label class="bb-dir-field bb-dir-master-custom-field">
                                <span>API-ключ</span>
                                <input id="bb-dir-master-api" class="bb-dir-input" type="password" placeholder="Токен или ключ доступа">
                            </label>
                            <label class="bb-dir-field bb-dir-master-custom-field">
                                <span>Модель</span>
                                <select id="bb-dir-master-model" class="bb-dir-input" disabled>
                                    <option value="">Модели не загружены</option>
                                </select>
                            </label>
                        </div>
                        <div class="bb-dir-note">Можно использовать текущие настройки SillyTavern, сохранённый профиль Connection Manager или отдельный OpenAI-compatible API.</div>
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

        $('#bb-dir-master-mode').on('change', function onMasterModeChange() {
            const value = String($(this).val() || '').trim();
            const master = getSettings().masterPreset;
            master.connectionMode = ['main', 'profile', 'custom'].includes(value) ? value : 'main';
            markMasterConnectionDirty({ clearModels: true });
        });

        $('#bb-dir-master-profile').on('change', function onMasterProfileChange() {
            getSettings().masterPreset.tavernProfileId = String($(this).val() || '').trim();
            markMasterConnectionDirty({ clearModels: true });
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
            if (getMasterConnectionMode() !== 'custom') {
                return;
            }

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
            void masterWorkflow.checkMasterConnection();
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
                    <div class="bb-dir-kicker">Scene Director</div>
                    <div class="bb-dir-title">SD</div>
                    <div class="bb-dir-subtitle">Настройка пресета ролевой игры</div>
                </div>

                <div class="bb-dir-toolbar">
                    <div class="bb-dir-block">
                        <button type="button" id="bb-dir-toolbar-toggle" class="bb-dir-toolbar-toggle" aria-expanded="true" aria-controls="bb-dir-toolbar-body">
                            <span class="bb-dir-block-title">Пресеты</span>
                            <span class="bb-dir-toolbar-arrow"><i class="fa-solid fa-chevron-down"></i></span>
                        </button>
                        <div id="bb-dir-toolbar-body" class="bb-dir-toolbar-body">
                            <div class="bb-dir-toolbar-body-inner">
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
                                <div class="bb-dir-master-request-wrap">
                                    <textarea id="bb-dir-master-request" class="bb-dir-input bb-dir-master-request" rows="2" placeholder="Опишите желаемый стиль: больше хоррора, романтика, экшен..."></textarea>
                                </div>
                                <div class="bb-dir-master-actions">
                                    <button id="bb-dir-master-generate" class="bb-dir-btn interactable bb-dir-with-icon bb-dir-btn-primary">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i><span>Сгенерировать пресет</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="bb-dir-list"></div>

                <div class="bb-dir-footer" id="bb-dir-footer">
                    <button type="button" id="bb-dir-footer-toggle" class="bb-dir-footer-toggle" aria-expanded="true" aria-controls="bb-dir-footer-body">
                        <span class="bb-dir-footer-handle"></span>
                        <span class="bb-dir-footer-toggle-label">Действия</span>
                        <span class="bb-dir-footer-arrow"><i class="fa-solid fa-chevron-down"></i></span>
                    </button>
                    <div id="bb-dir-footer-body" class="bb-dir-footer-body">
                        <div class="bb-dir-footer-body-inner">
                            <div class="bb-dir-footer-actions">
                                <button id="bb-dir-add-btn" class="bb-dir-btn interactable bb-dir-with-icon"><i class="fa-solid fa-folder-plus"></i><span>Добавить категорию</span></button>
                                <button id="bb-dir-pause-btn" class="bb-dir-btn interactable bb-dir-with-icon" type="button" aria-pressed="false"><i class="fa-solid fa-circle-pause"></i><span>Активен</span></button>
                                <button id="bb-dir-stealth-btn" class="bb-dir-btn interactable bb-dir-with-icon" title="Скрывать неактивные"><i class="fa-solid fa-eye-slash"></i><span>Скрыть неактивные</span></button>
                                <button id="bb-dir-preview-toggle" class="bb-dir-btn interactable bb-dir-with-icon"><i class="fa-solid fa-eye"></i><span>Показать промпт</span></button>
                            </div>
                            <div id="bb-dir-preview-wrap" class="bb-dir-preview-wrap is-closed" aria-hidden="true">
                                <div class="bb-dir-preview-inner">
                                    <div class="bb-dir-block-title">Текущий промпт</div>
                                    <div id="bb-dir-preview-text"></div>
                                </div>
                            </div>
                        </div>
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
                const nextExpanded = !currentState[categoryId];
                ensureCategoryExpansionState(categoryId, nextExpanded);
                saveSettingsDebounced();

                const section = $(this).closest('.bb-dir-section');
                const sectionList = section.find('.bb-dir-section-list').first();
                section.toggleClass('is-expanded', nextExpanded);
                section.toggleClass('is-collapsed', !nextExpanded);
                $(this).attr('aria-expanded', nextExpanded ? 'true' : 'false');
                sectionList.toggleClass('is-open', nextExpanded);
                sectionList.toggleClass('is-closed', !nextExpanded);
                sectionList.attr('aria-hidden', nextExpanded ? 'false' : 'true');
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

                void presetManager.handleDeleteCategory(categoryId);
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

        $('#bb-dir-load-preset').on('click', function onLoadPresetClick() {
            void presetManager.handleLoadPreset();
        });
        $('#bb-dir-update-preset').on('click', function onUpdateClick() {
            void presetManager.handleUpdatePreset(this);
        });
        $('#bb-dir-save-new-preset').on('click', function onSavePresetClick() {
            void presetManager.handleSaveNewPreset();
        });
        $('#bb-dir-rename-preset').on('click', function onRenamePresetClick() {
            void presetManager.handleRenamePreset();
        });
        $('#bb-dir-del-preset').on('click', function onDeletePresetClick() {
            void presetManager.handleDeletePreset();
        });
        $('#bb-dir-export-json').on('click', function onExportPresetClick() {
            void presetTransfer.handleExportPreset();
        });
        $('#bb-dir-import-json').on('click', function onImportPresetClick() {
            const input = presetTransfer.createImportFileInput();
            input.value = '';
            input.click();
        });

        presetTransfer.createImportFileInput().addEventListener('change', (event) => {
            const target = event.target;
            const file = target instanceof HTMLInputElement ? target.files?.[0] : null;
            void presetTransfer.handleImportPresetFile(file);
        });

        $('#bb-dir-stealth-btn').on('click', function onStealthClick() {
            getSettings().hideInactive = !getSettings().hideInactive;
            saveSettingsDebounced();
            renderDirectorHud();
        });

        $('#bb-dir-pause-btn').on('click', function onPauseClick() {
            getSettings().paused = !getSettings().paused;
            saveSettingsDebounced();
            updateDirectorPrompt();
            updatePauseButtonState();
        });

        $('#bb-dir-preview-toggle').on('click', function onPreviewToggle() {
            getSettings().previewExpanded = !getSettings().previewExpanded;
            saveSettingsDebounced();
            renderPreviewToggleState();
        });

        $('#bb-dir-toolbar-toggle').on('click', function onToolbarToggleClick() {
            getSettings().toolbarCollapsed = !getSettings().toolbarCollapsed;
            saveSettingsDebounced();
            renderToolbarCollapsedState();
        });

        $('#bb-dir-footer-toggle').on('click', function onFooterToggleClick() {
            getSettings().footerCollapsed = !getSettings().footerCollapsed;
            saveSettingsDebounced();
            renderFooterCollapsedState();
        });

        $('#bb-dir-master-generate').on('click', function onGenerateMaster() {
            const userRequest = String($('#bb-dir-master-request').val() || '').trim();
            void masterWorkflow.generateMasterPreset(userRequest);
        });

        renderPresetsDropdown();
        renderDirectorHud();
        renderMasterControls();
        renderToolbarCollapsedState();
        renderFooterCollapsedState();
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

    return {
        ensureDirectorHud,
        renderDirectorHud,
        renderMasterControls,
        renderPresetsDropdown,
        setupExtensionSettings,
        toggleHudVisibility,
        updateHudTopOffset,
    };
}
