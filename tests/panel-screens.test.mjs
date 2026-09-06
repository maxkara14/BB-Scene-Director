import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelScreens } from '../panel-screens.js';

function setup() {
    let focused = null, scope = 'A';
    class Node {
        children = []; parent = null; inert = false; hidden = false; attrs = {}; events = {}; className = ''; id = '';
        constructor(tag = 'div') { this.tag = tag; }
        classList = { add: c => { this.className += ` ${c}`; }, remove: c => { this.className = this.className.split(' ').filter(x => x !== c).join(' '); } };
        append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
        insertBefore(node, before) { node.remove(); const i = this.children.indexOf(before); node.parent = this; this.children.splice(i < 0 ? this.children.length : i, 0, node); }
        setAttribute(k, v) { this.attrs[k] = v; }
        addEventListener(k, fn) { this.events[k] = fn; }
        focus() { focused = this; }
        querySelector(selector) {
            for (const node of this.children) {
                if (selector[0] === '#' ? node.id === selector.slice(1) : selector[0] === '.' ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector) return node;
                const found = node.querySelector(selector); if (found) return found;
            }
            return null;
        }
    }
    const root = new Node(); root.id = 'bb-director-hud';
    const add = (parent, selector, tag) => { const node = new Node(tag); if (selector[0] === '#') node.id = selector.slice(1); else node.className = selector.slice(1); parent.append(node); return node; };
    const toolbar = add(root, '.bb-dir-toolbar');
    const select = add(toolbar, '#bb-dir-preset-select', 'select'); select.value = 'saved-preset';
    const actions = add(toolbar, '.bb-dir-preset-actions');
    const load = add(actions, '#bb-dir-load-preset', 'button'); let loaded = 0; load.addEventListener('click', () => loaded++);
    add(toolbar, '.bb-dir-preset-io');
    const master = add(toolbar, '.bb-dir-master-request-wrap');
    const input = add(master, '#bb-dir-master-request', 'textarea'); input.value = 'Unsaved request';
    add(toolbar, '.bb-dir-master-actions');
    const temporary = add(root, '.bb-dir-temporary');
    const list = add(root, '#bb-dir-list'); list.scrollTop = 145;
    const footer = add(root, '.bb-dir-footer'); footer.inert = true;
    const wrap = add(footer, '#bb-dir-preview-wrap'); const prompt = add(wrap, '#bb-dir-preview-text');
    add(footer, '#bb-dir-preview-toggle', 'button');
    const document = { getElementById: () => root, createElement: tag => new Node(tag) };
    const screens = createPanelScreens({ getScope: () => scope, getDocument: () => document });
    screens.mount();
    return { root, screens, select, load, input, prompt, list, footer, temporary, loaded: () => loaded, focused: () => focused, switchChat: () => { scope = 'B'; } };
}

test('screen mounting moves controls with their values and handlers, without duplicates', () => {
    const f = setup(); f.screens.mount();
    assert.equal(f.root.querySelector('.bb-dir-toolbar'), null);
    assert.equal(f.root.querySelector('#bb-dir-screen-presets').querySelector('#bb-dir-preset-select'), f.select);
    assert.equal(f.select.value, 'saved-preset');
    f.load.events.click(); assert.equal(f.loaded(), 1);
    assert.equal(f.root.children.filter(n => n.id === 'bb-dir-screen-presets').length, 1);
    assert.equal(f.root.querySelector('#bb-dir-screen-prompt').querySelector('#bb-dir-preview-text'), f.prompt);
});
test('navigation preserves request text, isolates hidden controls and restores focus/scroll', () => {
    const f = setup();
    f.root.querySelector('#bb-dir-open-master').events.click();
    assert.equal(f.list.inert, true);
    assert.equal(f.root.querySelector('#bb-dir-screen-master').inert, false);
    f.input.value = 'Changed request';
    f.screens.open('prompt');
    assert.equal(f.root.querySelector('#bb-dir-screen-master').hidden, true);
    f.screens.close();
    assert.equal(f.input.value, 'Changed request');
    assert.equal(f.list.inert, false);
    assert.equal(f.footer.inert, true);
    assert.equal(f.list.scrollTop, 145);
    assert.equal(f.focused().id, 'bb-dir-open-prompt');
});
test('a chat switch returns to scene without restoring old focus; same-chat rendering keeps screen open', () => {
    const f = setup(); f.screens.open('master'); f.screens.sync();
    assert.equal(f.root.querySelector('#bb-dir-screen-master').hidden, false);
    const focus = f.focused(); f.switchChat(); f.screens.sync();
    assert.equal(f.root.querySelector('#bb-dir-screen-master').hidden, true);
    assert.equal(f.list.inert, false);
    assert.equal(f.focused(), focus);
});
