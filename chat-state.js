import {
    createPresetItemFromDirective,
    getDefaultCategories,
    normalizeCategories,
    normalizeDirectives,
    normalizeExpandedCategories,
} from './preset-model.js';
import { normalizeTemporaryDirection } from './temporary-direction.js';

const METADATA_KEY = 'BB-Scene-Director';

export function createChatState({ getSettings, getContext, createPresetRecord, getUniquePresetName, saveGlobalSettings, notify }) {
    let activeKey = null;
    let lastRequestedSignature = null;

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function getChatKey(context = getContext()) {
        if (!context.chatId || !context.chatMetadata) {
            return null;
        }
        const owner = context.groupId != null
            ? ['group', context.groupId]
            : ['character', context.characters?.[context.characterId]?.avatar ?? context.characterId];
        return JSON.stringify([...owner, context.chatId]);
    }

    function capture() {
        const settings = getSettings();
        return clone({
            version: 1,
            directives: settings.directives,
            categories: settings.categories,
            expandedCategories: settings.expandedCategories,
            paused: settings.paused,
            temporaryDirection: settings.temporaryDirection || null,
            presetId: settings.presets[settings.lastActivePreset]?.id || null,
        });
    }

    function restore(raw = {}) {
        const settings = getSettings();
        const sourceCategories = normalizeCategories(raw.categories, [], [], getDefaultCategories());
        const directives = normalizeDirectives(Array.isArray(raw.directives) ? raw.directives : [], sourceCategories);
        const categories = normalizeCategories(sourceCategories, directives, [], getDefaultCategories());
        settings.directives = directives;
        settings.categories = categories;
        settings.expandedCategories = normalizeExpandedCategories(raw.expandedCategories, categories);
        settings.paused = raw.paused === true;
        settings.temporaryDirection = normalizeTemporaryDirection(raw.temporaryDirection);
        const index = settings.presets.findIndex((preset) => preset.id === raw.presetId);
        settings.lastActivePreset = index >= 0 ? index : null;
    }

    function isCurrentChat() {
        return activeKey !== null && activeKey === getChatKey();
    }

    function save({ deferMetadata = false } = {}) {
        const context = getContext();
        if (!activeKey || activeKey !== getChatKey(context)) {
            return;
        }
        const snapshot = capture();
        const signature = JSON.stringify(snapshot);
        context.chatMetadata[METADATA_KEY] = snapshot;
        if (deferMetadata || signature === lastRequestedSignature) {
            return;
        }
        const requestKey = activeKey;
        lastRequestedSignature = signature;
        // Use the current host context immediately; never retain a metadata-save timer across chats.
        void persist(context, requestKey, signature);
    }

    async function persist(context, requestKey, signature) {
        try {
            await context.saveMetadata();
        } catch {
            if (activeKey === requestKey && lastRequestedSignature === signature) {
                lastRequestedSignature = null;
            }
            notify('error', 'Не удалось сохранить сцену в чат. Проверь подключение к SillyTavern.');
        }
    }

    function activate() {
        const context = getContext();
        const nextKey = getChatKey(context);
        const changed = nextKey !== activeKey;
        activeKey = nextKey;
        if (!nextKey) {
            lastRequestedSignature = null;
            return changed;
        }

        const settings = getSettings();
        let initialScene = {};
        if (!settings.chatScenesInitialized) {
            initialScene = capture();
            if (initialScene.directives.length) {
                const backup = createPresetRecord(
                    getUniquePresetName('Общая сцена до SD-2'),
                    initialScene.directives.map(createPresetItemFromDirective),
                    { categories: initialScene.categories, summary: 'Копия общей сцены перед разделением по чатам.' },
                );
                settings.presets.push(backup);
            }
            settings.chatScenesInitialized = true;
        }

        const stored = context.chatMetadata[METADATA_KEY];
        restore(stored && typeof stored === 'object' ? stored : initialScene);
        lastRequestedSignature = stored ? JSON.stringify(stored) : null;
        saveGlobalSettings();
        save();
        return changed;
    }

    return { activate, getScope: () => activeKey, isCurrentChat, save };
}
