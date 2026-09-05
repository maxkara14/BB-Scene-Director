import { getDefaultCategories } from './preset-model.js';

// Keep the preset library intact; undo only changes the working scene in this page session.
export function createDraftState({ getSettings, getScope = () => '', historyLimit = 20 }) {
    const undoStack = [];
    const redoStack = [];
    let activeGroup = null;

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function capture() {
        const settings = getSettings();
        return clone({
            directives: settings.directives,
            categories: settings.categories,
            expandedCategories: settings.expandedCategories,
            presetId: settings.presets[settings.lastActivePreset]?.id || null,
        });
    }

    function contentSignature(categories, items) {
        return JSON.stringify({
            categories: categories.map(({ id, label, promptLabel, hint }) => ({ id, label, promptLabel, hint })),
            items: items.map(({ name, category, value, active }) => ({ name, category, value, active: active !== false })),
        });
    }

    function getSignature() {
        const settings = getSettings();
        return JSON.stringify([
            getScope(),
            settings.presets[settings.lastActivePreset]?.id || null,
            contentSignature(settings.categories, settings.directives),
        ]);
    }

    function getStatus() {
        const settings = getSettings();
        const preset = settings.presets[settings.lastActivePreset];
        const baseline = preset
            ? contentSignature(preset.categories, preset.items)
            : contentSignature(getDefaultCategories(), []);
        return {
            presetName: preset?.name || '',
            dirty: contentSignature(settings.categories, settings.directives) !== baseline,
            canUndo: undoStack.length > 0,
            canRedo: redoStack.length > 0,
        };
    }

    function checkpoint(group = null) {
        if (group && group === activeGroup) {
            return;
        }
        undoStack.push(capture());
        if (undoStack.length > historyLimit) {
            undoStack.shift();
        }
        redoStack.length = 0;
        activeGroup = group;
    }

    function endGroup() {
        activeGroup = null;
    }

    function clear() {
        undoStack.length = 0;
        redoStack.length = 0;
        endGroup();
    }

    function restore(snapshot) {
        const settings = getSettings();
        const restored = clone(snapshot);
        settings.directives = restored.directives;
        settings.categories = restored.categories;
        settings.expandedCategories = restored.expandedCategories;
        const presetIndex = settings.presets.findIndex((preset) => preset.id === restored.presetId);
        settings.lastActivePreset = presetIndex >= 0 ? presetIndex : null;
    }

    function moveHistory(source, target) {
        endGroup();
        if (!source.length) {
            return false;
        }
        target.push(capture());
        restore(source.pop());
        return true;
    }

    return {
        checkpoint,
        clear,
        endGroup,
        getSignature,
        getStatus,
        undo: () => moveHistory(undoStack, redoStack),
        redo: () => moveHistory(redoStack, undoStack),
    };
}
