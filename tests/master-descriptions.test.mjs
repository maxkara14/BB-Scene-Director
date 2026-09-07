import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../preset-model.js';
import { createMasterPresetParser } from '../master-preset-parser.js';
import { createFixture, loadWithHostMocks } from './helpers.mjs';

test('master requests descriptions in JSON schema, normal prompts and line fallback', async () => {
    const { createMasterPromptBuilder } = await loadWithHostMocks('master-prompts.js', {
        '../../../../script.js': { substituteParams: () => 'Character: Alice' },
    });
    const builder = createMasterPromptBuilder({ getCategories: model.getDefaultCategories });
    const schema = builder.buildMasterPresetJsonSchema().properties.categories.items.properties.directives.items;
    assert.ok(schema.required.includes('description'));
    assert.equal(schema.properties.description.maxLength, 1000);
    assert.match(builder.buildMasterMessages().systemPrompt, /"description"/);
    assert.match(builder.buildMasterMessages().systemPrompt, /every directive a non-empty description/);
    assert.match(builder.buildMasterCategoryRawMessages(model.getDefaultCategories()[0]).systemPrompt, /ITEM\|focus\|70\|short directive name\|true\|concise directive description/);
});

test('JSON and fallback descriptions survive parsing, preset storage and application; legacy lines remain valid', () => {
    const f = createFixture();
    const parser = createMasterPresetParser({ ...model, getCategories: () => f.settings.categories, getDirectives: () => f.settings.directives });
    const parsed = parser.parseMasterPresetResponse(JSON.stringify({ presetName: 'Test', categories: [{
        id: 'focus', label: 'Focus', hint: 'Panel help', directives: [
            { name: 'Mood', description: 'Build tension with pauses', value: 70, active: true },
        ],
    }] }));
    assert.equal(parsed.items[0].description, 'Build tension with pauses');
    const preset = model.normalizePreset({ name: 'Test', items: parsed.items, categories: parsed.categories });
    f.manager.applyPresetItems(preset.items, { replaceCategories: true, categories: preset.categories });
    assert.equal(f.settings.directives[0].description, 'Build tension with pauses');
    assert.equal(f.settings.categories[0].hint, 'Panel help');
    for (const line of ['ITEM|focus|75|Mood|true|Use pauses', 'focus|Mood|75|true|Use pauses']) {
        assert.equal(parser.parseMasterLineResponse(line).items[0].description, 'Use pauses');
    }
    for (const line of ['ITEM|focus|75|Mood', 'ITEM|focus|75|Mood|true', 'ITEM|focus|75|Mood|true|']) {
        const item = parser.parseMasterLineResponse(line).items[0];
        assert.equal(item.name, 'Mood');
        assert.equal(item.description, '');
    }
});

test('description opt-out agrees across schema, JSON request and line fallback', async () => {
    const { createMasterPromptBuilder } = await loadWithHostMocks('master-prompts.js', {
        '../../../../script.js': { substituteParams: () => 'Character: Alice' },
    });
    const builder = createMasterPromptBuilder({ getCategories: model.getDefaultCategories });
    const options = { generateDescriptions: false };
    const item = builder.buildMasterPresetJsonSchema(undefined, options).properties.categories.items.properties.directives.items;
    assert.equal(item.properties.description, undefined);
    assert.ok(!item.required.includes('description'));
    const prompt = builder.buildMasterMessages('Horror', options).systemPrompt;
    assert.match(prompt, /Do not generate directive descriptions/);
    assert.doesNotMatch(prompt, /"description":|every directive a non-empty/);
    const fallback = builder.buildMasterCategoryRawMessages(model.getDefaultCategories()[0], options).systemPrompt;
    assert.match(fallback, /end the line after true/);
    assert.doesNotMatch(fallback, /true\|concise/);
    assert.ok(builder.buildMasterPresetJsonSchema().properties.categories.items.properties.directives.items.required.includes('description'));
});
