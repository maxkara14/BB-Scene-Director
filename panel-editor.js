import { normalizeDirectiveDescription } from './preset-model.js';

// Variant A: edits stay local until Save; each accepted edit is one undo step.
export function createPanelEditSession({ kind, id, getSettings, getScope, draftState }) {
    const signature = () => JSON.stringify([getScope(), draftState.getSignature(), getSettings().directives]);
    const source = () => (kind === 'directive' ? getSettings().directives : getSettings().categories).find(item => item.id === id);
    if (!source()) return null;
    const initialSignature = signature();
    const initial = JSON.parse(JSON.stringify(source()));
    const isCurrent = () => initialSignature === signature() && Boolean(source());
    function save(fields) {
        if (!isCurrent()) return 'stale';
        const name = String(fields.name || '').trim();
        if (!name) return 'invalid';
        let next;
        if (kind === 'directive') {
            if (!getSettings().categories.some(category => category.id === fields.category)) return 'invalid';
            next = { ...initial, name, description: normalizeDirectiveDescription(fields.description), category: fields.category, locked: fields.locked === true };
        } else {
            next = { ...initial, label: name, hint: String(fields.hint || '').trim() };
        }
        if (JSON.stringify(next) === JSON.stringify(source())) return 'unchanged';
        draftState.checkpoint();
        Object.assign(source(), next);
        if (kind === 'directive') getSettings().expandedCategories[next.category] = true;
        return 'saved';
    }
    function remove() {
        if (!isCurrent()) return 'stale';
        if (kind !== 'directive') return 'invalid';
        draftState.checkpoint();
        getSettings().directives = getSettings().directives.filter(item => item.id !== id);
        return 'saved';
    }
    return { initial, isCurrent, save, remove };
}

export function createPanelEditor({ getSettings, getScope, draftState, escapeHtml, changed, notify, deleteCategory }) {
    let active = null;
    function close(refresh = false, restore = true) {
        if (!active) return;
        const previous = active;
        active = null;
        previous.root.remove();
        previous.hud.classList.remove('bb-dir-editing');
        for (const [node, inert] of previous.siblings) node.inert = inert;
        if (refresh) changed();
        if (!restore || getScope() !== previous.scope) return;
        const candidates = previous.hud.querySelectorAll(previous.kind === 'directive' ? '.bb-dir-open-editor' : '.bb-dir-section-editor');
        const target = [...candidates].find(node => previous.kind === 'directive'
            ? node.closest('.bb-dir-card')?.dataset.id === previous.id : node.dataset.categoryId === previous.id);
        (target || previous.hud.querySelector('.bb-dir-section-toggle'))?.focus({ preventScroll: true });
        if (previous.list) previous.list.scrollTop = previous.scroll;
    }
    function sync() {
        if (!active || active.session.isCurrent()) return;
        close(false, false);
        notify('info', 'Сцена изменилась. Редактор закрыт; несохранённые правки не применены.');
    }
    function open(kind, id) {
        const hud = document.getElementById('bb-director-hud');
        if (!hud) return;
        const session = createPanelEditSession({ kind, id, getSettings, getScope, draftState });
        if (!session) return;
        close(false, false);
        const item = session.initial;
        const directive = kind === 'directive';
        const root = document.createElement('section');
        root.id = 'bb-dir-editor';
        root.setAttribute('aria-label', directive ? 'Редактор директивы' : 'Редактор группы');
        root.innerHTML = `
            <header class="bb-dir-editor-head"><button type="button" data-close class="bb-dir-btn">← К сцене</button><h3>${directive ? 'Директива' : 'Группа директив'}</h3></header>
            <form class="bb-dir-editor-form">
                <div class="bb-dir-editor-body">
                    <label class="bb-dir-field"><span>Название</span><input class="bb-dir-input" name="name" required value="${escapeHtml(directive ? item.name : item.label)}"></label>
                    <label class="bb-dir-field"><span>${directive ? 'Описание' : 'Описание группы'}</span><textarea class="bb-dir-input" name="description" rows="5" ${directive ? 'maxlength="1000"' : ''}>${escapeHtml((directive ? item.description : item.hint) || '')}</textarea><small>${directive ? 'Передаётся модели вместе с интенсивностью. До 1000 символов.' : 'Подсказка в панели. Не добавляется в режиссёрский промпт.'}</small></label>
                    ${directive ? `<label class="bb-dir-field"><span>Группа</span><select class="bb-dir-input" name="category">${getSettings().categories.map(category => `<option value="${escapeHtml(category.id)}" ${category.id === item.category ? 'selected' : ''}>${escapeHtml(category.label)}</option>`).join('')}</select></label><label class="checkbox_label"><input type="checkbox" name="locked" ${item.locked ? 'checked' : ''}><span>Защитить от изменений мастером</span></label>` : ''}
                    <button type="button" data-delete class="bb-dir-btn bb-dir-danger" ${!directive && getSettings().categories.length <= 1 ? 'disabled' : ''}>${directive ? 'Удалить директиву' : 'Удалить группу'}</button>
                    <p class="bb-dir-editor-message" role="status"></p>
                </div>
                <footer class="bb-dir-editor-foot"><button type="button" data-close class="bb-dir-btn">Отмена</button><button type="submit" class="bb-dir-btn bb-dir-btn-primary">Сохранить</button></footer>
            </form>`;
        const siblings = [...hud.children].map(node => [node, node.inert]);
        const list = document.getElementById('bb-dir-list');
        active = { session, root, hud, siblings, list, scroll: list?.scrollTop || 0, scope: getScope(), kind, id };
        for (const [node] of siblings) node.inert = true;
        hud.append(root);
        hud.classList.add('bb-dir-editing');
        root.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => close()));
        root.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        });
        root.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            const data = new FormData(event.target);
            const result = session.save({ name: data.get('name'), description: data.get('description'), hint: data.get('description'), category: data.get('category'), locked: data.has('locked') });
            if (result === 'stale') { sync(); return; }
            if (result === 'invalid') { root.querySelector('[role=status]').textContent = 'Укажи название и существующую группу.'; return; }
            close(result === 'saved');
        });
        root.querySelector('[data-delete]').addEventListener('click', async () => {
            if (!session.isCurrent()) { sync(); return; }
            if (directive) { session.remove(); close(true); }
            else {
                await deleteCategory(id);
                // The manager guards its confirmation against a changed scene.
                sync();
            }
        });
        root.querySelector('[data-close]').focus();
    }
    return { open, close, sync };
}
