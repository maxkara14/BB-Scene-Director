// Persistent screens retain the existing controls, listeners and unsent form text.
export function createPanelScreens({ getScope, getDocument = () => document }) {
    let hud = null;
    let current = null;
    const screens = new Map();
    function close(restore = true) {
        if (!current) return;
        const previous = current;
        current = null;
        previous.screen.hidden = true;
        previous.screen.inert = true;
        previous.screen.classList.remove('is-current');
        hud.classList.remove('bb-dir-screen-mode');
        for (const [node, inert] of previous.siblings) node.inert = inert;
        previous.button.setAttribute('aria-expanded', 'false');
        if (restore && previous.scope === getScope()) {
            previous.button.focus({ preventScroll: true });
            const list = hud.querySelector('#bb-dir-list');
            if (list) list.scrollTop = previous.scroll;
        }
    }
    function open(name) {
        const entry = screens.get(name);
        if (!entry) return;
        close(false);
        const siblings = [...hud.children].filter(node => node !== entry.screen).map(node => [node, node.inert]);
        current = { ...entry, siblings, scope: getScope(), scroll: hud.querySelector('#bb-dir-list')?.scrollTop || 0 };
        for (const [node] of siblings) node.inert = true;
        entry.screen.hidden = false;
        entry.screen.inert = false;
        entry.screen.classList.add('is-current');
        hud.classList.add('bb-dir-screen-mode');
        entry.button.setAttribute('aria-expanded', 'true');
        entry.screen.querySelector('button').focus();
    }
    function sync() { if (current && current.scope !== getScope()) close(false); }
    function mount() {
        const document = getDocument();
        hud = document.getElementById('bb-director-hud');
        if (!hud || screens.size) return;
        const nav = document.createElement('nav');
        nav.className = 'bb-dir-screen-nav';
        nav.setAttribute('aria-label', 'Инструменты сцены');
        const definitions = [
            ['presets', 'Пресеты', ['#bb-dir-preset-select', '.bb-dir-preset-actions', '.bb-dir-preset-io']],
            ['master', 'Мастер', ['.bb-dir-master-request-wrap', '.bb-dir-master-actions']],
            ['prompt', 'Промпт', ['#bb-dir-preview-text']],
            ['temporary', 'Временное указание', ['#bb-dir-temporary-body']],
        ];
        for (const [name, title, selectors] of definitions) {
            const screen = document.createElement('section');
            screen.id = `bb-dir-screen-${name}`;
            screen.className = 'bb-dir-screen';
            screen.hidden = true;
            screen.inert = true;
            screen.setAttribute('aria-label', title);
            const head = document.createElement('header');
            head.className = 'bb-dir-screen-head';
            const back = document.createElement('button');
            back.type = 'button'; back.className = 'bb-dir-btn'; back.textContent = '← К сцене';
            back.addEventListener('click', () => close());
            const heading = document.createElement('h3'); heading.textContent = title === 'Мастер' ? 'Мастер сцены' : title === 'Промпт' ? 'Текущий промпт' : title;
            head.append(back, heading);
            const body = document.createElement('div'); body.className = 'bb-dir-screen-body';
            for (const selector of selectors) { const node = hud.querySelector(selector); if (node) body.append(node); }
            screen.append(head, body);
            const button = name === 'temporary' ? hud.querySelector('#bb-dir-temporary-toggle') : document.createElement('button');
            if (!button) continue;
            if (name !== 'temporary') {
                button.type = 'button'; button.className = 'bb-dir-btn'; button.textContent = title;
                button.id = `bb-dir-open-${name}`;
                nav.append(button);
            }
            button.setAttribute('aria-controls', screen.id); button.setAttribute('aria-expanded', 'false');
            button.addEventListener('click', () => open(name));
            hud.append(screen); screens.set(name, { button, screen });
            if (name === 'temporary') {
                const formBody = screen.querySelector('#bb-dir-temporary-body');
                if (formBody) { formBody.inert = false; formBody.setAttribute('aria-hidden', 'false'); }
            }
            screen.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
        }
        hud.querySelector('.bb-dir-toolbar')?.remove();
        hud.querySelector('#bb-dir-preview-wrap')?.remove();
        hud.querySelector('#bb-dir-preview-toggle')?.remove();
        hud.insertBefore(nav, hud.querySelector('.bb-dir-temporary'));
        hud.querySelector('#bb-dir-preset-select')?.setAttribute('aria-label', 'Сохранённый пресет');
        for (const [id, label] of [['load-preset','Загрузить'],['update-preset','Перезаписать'],['save-new-preset','Сохранить как новый'],['rename-preset','Переименовать'],['del-preset','Удалить']]) {
            const button = hud.querySelector(`#bb-dir-${id}`);
            if (!button) continue;
            const span = document.createElement('span'); span.textContent = label; button.append(span);
        }
    }
    return { mount, open, close, sync };
}
