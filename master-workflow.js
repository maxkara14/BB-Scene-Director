import {
    createTimedAbortController,
    describeMasterConnection,
    describeMasterResponseSnippet,
    fetchMasterModelsDirect,
    fetchMasterModelsViaBackend,
    getMasterConnectionDetails,
    getMasterProfileLabel,
    getSupportedMasterProfiles,
    isAbortLikeError,
    MASTER_CONNECTION_MODES,
    requestMasterPresetDirect,
    requestMasterPresetViaMainConnection,
    requestMasterPresetViaProfile,
    shouldRetryMasterGeneration,
    tryGetMainMasterConnection,
} from './master-connection.js';

export function createMasterWorkflow({
    abortMasterGeneration,
    draftState,
    constants,
    getContext,
    getMasterSettings,
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
    sceneEditor,
    updateDirectorPrompt,
}) {
    const {
        DEFAULT_MASTER_MAX_TOKENS,
        DEFAULT_MASTER_TEMPERATURE,
        MASTER_GENERATION_MAX_ATTEMPTS,
        MASTER_REQUEST_TIMEOUT_MS,
        MASTER_STATUS_TIMEOUT_MS,
        MASTER_STRUCTURED_MIN_TEMPERATURE,
        MASTER_STRUCTURED_MIN_TOKENS,
    } = constants;

    function resolveMasterConnection(options = {}) {
        return getMasterConnectionDetails(getMasterSettings(), normalizeBaseUrl, options);
    }

    function getGenerationAvailability() {
        try {
            const connection = resolveMasterConnection();
            const model = String(connection?.model || '').trim();
            return {
                available: connection?.mode === MASTER_CONNECTION_MODES.PROFILE
                    ? Boolean(connection.profileId)
                    : Boolean(model),
                mode: connection?.mode || null,
                model,
                label: describeMasterConnection(connection),
            };
        } catch {
            return {
                available: false,
                mode: null,
                model: '',
                label: '',
            };
        }
    }

    function getStructuredMasterGenerationSettings(master) {
        return {
            maxTokens: Math.max(Number(master?.maxTokens) || DEFAULT_MASTER_MAX_TOKENS, MASTER_STRUCTURED_MIN_TOKENS),
            temperature: Math.max(Number(master?.temperature) || DEFAULT_MASTER_TEMPERATURE, MASTER_STRUCTURED_MIN_TEMPERATURE),
        };
    }

    async function checkMasterConnection() {
        const master = getMasterSettings();
        let connection;
        const { controller, cleanup } = createTimedAbortController(
            MASTER_STATUS_TIMEOUT_MS,
            'Проверка подключения заняла слишком много времени.',
        );

        try {
            connection = resolveMasterConnection({ requireModel: false });
        } catch (error) {
            cleanup();
            notify('warning', error.message || 'Проверь параметры подключения.');
            return;
        }

        state.masterChecking = true;
        renderMasterControls();

        try {
            if (connection.mode === MASTER_CONNECTION_MODES.MAIN || connection.mode === MASTER_CONNECTION_MODES.PROFILE) {
                master.statusLevel = 'success';
                master.statusText = `Готово. Для генерации используется ${describeMasterConnection(connection)}.`;
                saveSettingsDebounced();
                renderMasterControls();
                notify('success', 'Подключение выбрано.');
                return;
            }

            let modelIds = [];
            try {
                modelIds = await fetchMasterModelsDirect(connection.url, connection.apiKey, controller.signal);
            } catch (directError) {
                console.warn('[BB Scene Director] Direct model check failed, trying backend fallback.', directError);
                if (isAbortLikeError(directError)) {
                    throw directError;
                }
                modelIds = await fetchMasterModelsViaBackend(connection.url, connection.apiKey, controller.signal, normalizeBaseUrl);
            }

            master.availableModels = modelIds;

            if (!modelIds.length) {
                throw new Error('Список моделей пустой.');
            }

            if (!master.model || !modelIds.includes(master.model)) {
                master.model = modelIds[0];
            }

            master.statusLevel = 'success';
            master.statusText = `Подключено. Найдено моделей: ${modelIds.length}. Активная модель: ${master.model}.`;

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

    async function generateMasterPreset(userRequest = '', options = {}) {
        if (state.masterGenerating) {
            notify('info', 'Мастер уже готовит результат.');
            return;
        }

        const master = getMasterSettings();
        const editing = options.mode === 'edit';
        const generateDescriptions = master.generateDescriptions !== false;
        const presetSize = master.presetSize === 'compact' ? 'compact' : 'standard';
        let editRequest;
        let prompt;
        try {
            if (editing) {
                editRequest = sceneEditor.prepare(userRequest, options.messageCount, masterPromptBuilder.getResolvedMasterContext());
                prompt = editRequest;
            } else {
                prompt = masterPromptBuilder.buildMasterMessages(userRequest, { generateDescriptions, presetSize });
            }
        } catch (error) {
            notify('warning', error.message);
            return;
        }
        const { sourceText, systemPrompt, userPrompt } = prompt;
        if (!sourceText) {
            notify('warning', 'Не удалось собрать данные из макросов персонажа и персоны.');
            return;
        }

        let connection;
        try {
            connection = resolveMasterConnection();
        } catch (error) {
            notify('warning', error.message || 'Проверь параметры подключения.');
            return;
        }

        if (connection.mode !== MASTER_CONNECTION_MODES.PROFILE && !connection.model) {
            notify('warning', 'Сначала выбери модель для генерации.');
            return;
        }

        if ((!editing && !await presetManager.confirmDraftReplacement()) || state.masterGenerating) {
            return;
        }
        const originalDraftSignature = draftState.getSignature();
        const allowMainFallback = master.allowMainFallback === true;
        const context = getContext();
        const { controller, cleanup } = createTimedAbortController(
            MASTER_REQUEST_TIMEOUT_MS,
            'Запрос к мастеру занял слишком много времени.',
        );
        state.masterAbortController = controller;

        const loaderHandle = context.loader?.show({
            message: editing ? 'Готовлю изменения сцены...' : 'Собираю пресет...',
            blocking: true,
            onStop: () => abortMasterGeneration('Отменено пользователем.'),
        });

        state.masterGenerating = true;
        renderMasterControls();

        let lastRawMasterResponse = null;
        let parsed = null;
        let loaderHidden = false;

        try {
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ];
            const structuredSettings = getStructuredMasterGenerationSettings(master);

            for (let attempt = 1; attempt <= MASTER_GENERATION_MAX_ATTEMPTS; attempt++) {
                let rawResponse;
                try {
                    if (connection.mode === MASTER_CONNECTION_MODES.CUSTOM) {
                        rawResponse = await requestMasterPresetDirect({
                            url: connection.url,
                            apiKey: connection.apiKey,
                            model: connection.model,
                            messages,
                            maxTokens: structuredSettings.maxTokens,
                            temperature: structuredSettings.temperature,
                            signal: controller.signal,
                        });
                    } else if (connection.mode === MASTER_CONNECTION_MODES.PROFILE) {
                        rawResponse = await requestMasterPresetViaProfile({
                            connection,
                            messages,
                            maxTokens: structuredSettings.maxTokens,
                            temperature: structuredSettings.temperature,
                            signal: controller.signal,
                        });
                    } else {
                        rawResponse = await requestMasterPresetViaMainConnection({
                            context,
                            connection,
                            messages,
                            maxTokens: undefined,
                            temperature: structuredSettings.temperature,
                            signal: controller.signal,
                        });
                    }
                } catch (error) {
                    if (controller.signal.aborted || isAbortLikeError(error)) {
                        throw error;
                    }

                    const mainFallback = connection.mode === MASTER_CONNECTION_MODES.CUSTOM && allowMainFallback
                        ? tryGetMainMasterConnection(normalizeBaseUrl)
                        : null;

                    if (!mainFallback) {
                        throw error;
                    }

                    console.warn('[BB Scene Director] Custom master connection failed, falling back to the main SillyTavern connection.', error);
                    notify('warning', 'Отдельный API недоступен. Использую основное подключение SillyTavern согласно настройке резерва.');
                    connection = mainFallback;
                    rawResponse = await requestMasterPresetViaMainConnection({
                        context,
                        connection,
                        messages,
                        maxTokens: undefined,
                        temperature: structuredSettings.temperature,
                        signal: controller.signal,
                    });
                }
                lastRawMasterResponse = rawResponse;

                try {
                    if (editing) {
                        parsed = sceneEditor.parse(rawResponse, editRequest);
                    } else {
                        parsed = masterPresetParser.parseMasterPresetResponse(rawResponse);
                        if (!generateDescriptions) parsed.items = parsed.items.map(item => ({ ...item, description: '' }));
                        masterPresetParser.validateMasterPresetQuality(parsed.items, { allowPartial: parsed.partial, presetSize });
                    }
                    break;
                } catch (error) {
                    if (isAbortLikeError(error)) {
                        throw error;
                    }

                    if (shouldRetryMasterGeneration(error, rawResponse, attempt, MASTER_GENERATION_MAX_ATTEMPTS)) {
                        console.warn(
                            `[BB Scene Director] Weak or truncated master response on attempt ${attempt}/${MASTER_GENERATION_MAX_ATTEMPTS}, retrying once.`,
                            {
                                message: error.message,
                                responseLength: typeof rawResponse === 'string' ? rawResponse.length : 0,
                            },
                        );
                        parsed = null;
                        continue;
                    }

                    throw error;
                }
            }

            if (!parsed) {
                throw new Error('Не удалось собрать пресет после повторной попытки.');
            }

            if (controller.signal.aborted) {
                throw new Error('Генерация отменена.');
            }
            if (editing) {
                // The request timeout and blocking loader must not cover human review time.
                cleanup();
                if (loaderHandle?.hide) await loaderHandle.hide();
                loaderHidden = true;
                const result = await sceneEditor.review(parsed, editRequest, controller.signal);
                const messages = {
                    applied: 'Выбранные изменения применены. Их можно отменить кнопкой «Отменить».',
                    cancelled: 'Изменения не применены.',
                    empty: 'Мастер не предложил изменений доступных директив.',
                    stale: 'Чат или сцена изменились либо запрос отменён. Результат не применён.',
                };
                master.statusLevel = result === 'applied' ? 'success' : 'idle';
                master.statusText = messages[result];
                saveSettingsDebounced();
                renderDirectorHud();
                updateDirectorPrompt();
                notify(result === 'applied' ? 'success' : 'info', messages[result]);
                return;
            }
            const shouldApply = draftState.getSignature() === originalDraftSignature;
            const generatedPresetEntry = presetManager.saveGeneratedPreset({
                presetName: parsed.presetName,
                items: parsed.items,
                categories: parsed.categories,
                partial: parsed.partial,
                select: false,
            });

            if (shouldApply) {
                presetManager.applyPresetItems(parsed.items, {
                    presetIndex: generatedPresetEntry.index,
                    expandTouchedCategories: true,
                    replaceCategories: Array.isArray(parsed.categories) && parsed.categories.length > 0,
                    categories: parsed.categories,
                });
            }

            master.lastPresetName = generatedPresetEntry.preset.name;
            master.statusLevel = 'success';
            master.statusText = `Готово. Для генерации используется ${describeMasterConnection(connection)}.`;
            saveSettingsDebounced();

            renderPresetsDropdown();
            renderDirectorHud();
            renderMasterControls();
            updateDirectorPrompt();

            if (parsed.partial) {
                console.warn('[BB Scene Director] Master preset was partially recovered from a truncated response.');
            }

            if (!shouldApply) {
                notify('info', 'Пресет сохранён в библиотеку. Текущая сцена изменилась за время генерации, поэтому результат не применён.');
            } else {
                notify('success', parsed.partial
                    ? `Пресет "${generatedPresetEntry.preset.name}" частично восстановлен, сохранён и применён.`
                    : `Пресет "${generatedPresetEntry.preset.name}" собран, сохранён и применён.`);
            }
        } catch (error) {
            const aborted = controller.signal.aborted || isAbortLikeError(error);
            master.statusLevel = aborted ? 'idle' : 'error';
            master.statusText = aborted
                ? String(controller.signal.reason || error.message || 'Сборка пресета отменена.')
                : (error.message || 'Не удалось собрать пресет.');
            saveSettingsDebounced();
            renderMasterControls();

            if (lastRawMasterResponse && !editing) {
                console.warn('[BB Scene Director] Raw master response snippet:', describeMasterResponseSnippet(lastRawMasterResponse));
            }
            console.error('[BB Scene Director] Master preset generation failed.', error);
            notify(aborted ? 'info' : 'error', master.statusText);
        } finally {
            cleanup();
            state.masterAbortController = null;
            state.masterGenerating = false;
            renderMasterControls();

            if (!loaderHidden && loaderHandle?.hide) {
                await loaderHandle.hide();
            }
        }
    }

    return {
        getGenerationAvailability,
        getMasterProfileLabel,
        getSupportedMasterProfiles,
        checkMasterConnection,
        generateMasterPreset,
    };
}
