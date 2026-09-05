import { makeId } from './preset-model.js';

export function normalizeTemporaryDirection(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 2000) : '';
    if (!text) return null;
    const duration = [1, 3, 5].includes(raw.duration) ? raw.duration : null;
    return {
        id: String(raw.id || makeId('temporary')), text, duration,
        remaining: duration === null ? null : Math.max(0, Math.min(duration, Number.isInteger(raw.remaining) ? raw.remaining : duration)),
        enabled: raw.enabled !== false,
        countBy: 'user-turn',
        // Old directions retain their remaining budget for the current turn.
        turnStarted: raw.countBy === 'user-turn' ? raw.turnStarted === true : true,
        lastUserKey: typeof raw.lastUserKey === 'string' ? raw.lastUserKey : null,
        userBoundary: Number.isInteger(raw.userBoundary) ? raw.userBoundary : -1,
    };
}

export function createTemporaryDirectionController({ getSettings, getContext, isCurrentChat, save, changed }) {
    let preparing = null;
    const current = () => getSettings().temporaryDirection;
    const messageKey = (message, index) => JSON.stringify([index, message.send_date ?? null]);
    const latestUserKey = () => {
        const chat = getContext().chat || [];
        const index = chat.findLastIndex((message) => message.is_user && !message.is_system);
        return index < 0 ? null : messageKey(chat[index], index);
    };
    const scope = () => {
        const context = getContext();
        return JSON.stringify([context.chatId, context.groupId ?? context.characterId]);
    };

    function preparingReply(type, options = {}, dryRun = false) {
        if (dryRun) return;
        if (['quiet', 'impersonate'].includes(type)) {
            preparing = null;
            return;
        }
        const note = current();
        preparing = isCurrentChat() && !getSettings().paused && note?.enabled && !note.turnStarted
            ? { id: note.id, scope: scope(), userKey: latestUserKey(), signal: options.signal } : null;
    }

    function replyPrepared(dryRun = false) {
        if (dryRun) return false;
        const pending = preparing;
        preparing = null;
        const note = current();
        if (!pending || pending.signal?.aborted || !pending.userKey || pending.scope !== scope()
            || !isCurrentChat() || getSettings().paused || !note?.enabled || note.turnStarted
            || pending.id !== note.id || pending.userKey !== latestUserKey() || note.remaining === 0) return false;
        // Preparing a reroll can start the current turn even when the last chat
        // entry is an old/interrupted character reply. This never spends a turn.
        note.turnStarted = true;
        note.lastUserKey = pending.userKey;
        save();
        changed();
        return true;
    }

    function arm(text, duration) {
        if (!isCurrentChat()) return false;
        const chat = getContext().chat || [];
        const index = chat.findLastIndex((message) => !message.is_system);
        const last = chat[index];
        const note = normalizeTemporaryDirection({
            text, duration, countBy: 'user-turn', turnStarted: last?.is_user === true,
            lastUserKey: last?.is_user ? messageKey(last, index) : null,
            userBoundary: chat.length - 1,
        });
        if (!note) return false;
        getSettings().temporaryDirection = note;
        save();
        changed();
        return true;
    }

    function stop() {
        if (!isCurrentChat() || !current()) return;
        current().enabled = false;
        save();
        changed();
    }

    function getText() {
        const note = current();
        if (!isCurrentChat() || getSettings().paused || !note?.enabled) return '';
        return note.remaining === null || note.remaining > 0 ? note.text : '';
    }

    function userSent(index) {
        if (typeof index === 'string' && /^\d+$/.test(index)) index = Number(index);
        const note = current();
        const chat = getContext().chat || [];
        const message = chat[index];
        if (!isCurrentChat() || getSettings().paused || !note?.enabled || note.remaining === null || note.remaining <= 0
            || !Number.isInteger(index) || index <= (note.userBoundary ?? -1) || !message?.is_user || message.is_system) return false;
        const key = messageKey(message, index);
        if (key === note.lastUserKey) return false;
        note.lastUserKey = key;
        note.userBoundary = index;
        if (note.turnStarted) note.remaining--;
        else note.turnStarted = true;
        // The host saves the user's message before MESSAGE_SENT. Save the updated
        // metadata here, even if no character generation follows.
        save();
        changed();
        return true;
    }

    return { arm, stop, getText, userSent, preparingReply, replyPrepared };
}
