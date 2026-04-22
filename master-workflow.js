import {
    createTimedAbortController,
    describeMasterResponseSnippet,
    fetchMasterModelsDirect,
    fetchMasterModelsViaBackend,
    getMasterConnectionDetails,
    isAbortLikeError,
    requestMasterPresetDirect,
    shouldRetryMasterGeneration,
} from './master-connection.js';

export function createMasterWorkflow({
    abortMasterGeneration,
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

    function resolveMasterConnection() {
        return getMasterConnectionDetails(getMasterSettings(), normalizeBaseUrl);
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
            connection = resolveMasterConnection();
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

    async function generateMasterPreset() {
        if (state.masterGenerating) {
            notify('info', 'Сборка пресета уже идёт.');
            return;
        }

        const master = getMasterSettings();
        const { sourceText, systemPrompt, userPrompt } = masterPromptBuilder.buildMasterMessages();
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

        if (!connection.model) {
            notify('warning', 'Сначала выбери модель для генерации.');
            return;
        }

        const context = getContext();
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
        let parsed = null;

        try {
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ];
            const structuredSettings = getStructuredMasterGenerationSettings(master);

            for (let attempt = 1; attempt <= MASTER_GENERATION_MAX_ATTEMPTS; attempt++) {
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

                try {
                    parsed = masterPresetParser.parseMasterPresetResponse(rawResponse);
                    masterPresetParser.validateMasterPresetQuality(parsed.items, { allowPartial: parsed.partial });
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

            const generatedPresetEntry = presetManager.saveGeneratedPreset({
                presetName: parsed.presetName,
                items: parsed.items,
                categories: parsed.categories,
                partial: parsed.partial,
            });

            presetManager.applyPresetItems(parsed.items, {
                clearSelectedPreset: false,
                expandTouchedCategories: true,
                replaceCategories: Array.isArray(parsed.categories) && parsed.categories.length > 0,
                categories: parsed.categories,
            });

            master.lastPresetName = generatedPresetEntry.preset.name;
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
                ? `Пресет "${generatedPresetEntry.preset.name}" частично восстановлен, сохранён и применён.`
                : `Пресет "${generatedPresetEntry.preset.name}" собран, сохранён и применён.`);
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

    return {
        checkMasterConnection,
        generateMasterPreset,
    };
}
