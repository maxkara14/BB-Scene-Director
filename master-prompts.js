import { substituteParams } from '../../../../script.js';

const MASTER_CONTEXT_TEMPLATE = [
    'Имя персонажа: {{char}}',
    'Описание персонажа: {{description}}',
    'Характер персонажа: {{personality}}',
    'Сценарий: {{scenario}}',
    'Имя пользователя: {{user}}',
    'Персона пользователя: {{persona}}',
    'Название группы: {{group}}',
].join('\n');

function getGenerationFocusInstruction(focus) {
    return focus === 'style'
        ? 'Generation focus: narrative style. Build reusable genre, tone, atmosphere, pacing and narrative emphasis directives (for example horror, comedy, tenderness or suspense). Use character context to choose suitable style, not to invent specific events, encounters, missions or character actions. Descriptions, when enabled, explain how to express the style. Change this approach only when the user explicitly requests concrete events.'
        : 'Generation focus: concrete scene. Build context-specific directives about character dynamics, conflicts, behavior and scene development. Ground them in the supplied character and scenario context; do not invent unsupported lore or write the actual roleplay reply. Follow an explicit user request for a different approach.';
}

export function createMasterPromptBuilder({
    getCategories,
    fallbackCategoryTargets = {},
}) {
    function getFallbackCategoryTargetCount(categoryId, fallback = 2) {
        const value = Number(fallbackCategoryTargets?.[categoryId]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    }

    function buildMasterPresetJsonSchema(categories = getCategories(), options = {}) {
        const schema = {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                presetName: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 80,
                },
                categories: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 8,
                    items: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'string',
                                minLength: 1,
                                maxLength: 40,
                            },
                            label: {
                                type: 'string',
                                minLength: 1,
                                maxLength: 60,
                            },
                            promptLabel: {
                                type: 'string',
                                minLength: 1,
                                maxLength: 60,
                            },
                            hint: {
                                type: 'string',
                                minLength: 0,
                                maxLength: 120,
                            },
                            directives: {
                                type: 'array',
                                minItems: 1,
                                maxItems: 4,
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: {
                                            type: 'string',
                                            minLength: 1,
                                            maxLength: 60,
                                        },
                                        description: {
                                            type: 'string',
                                            minLength: 1,
                                            maxLength: 1000,
                                        },
                                        value: {
                                            type: 'integer',
                                            minimum: 5,
                                            maximum: 100,
                                            multipleOf: 5,
                                        },
                                        active: {
                                            type: 'boolean',
                                            enum: [true],
                                        },
                                    },
                                    required: ['name', 'description', 'value', 'active'],
                                    additionalProperties: false,
                                },
                            },
                        },
                        required: ['id', 'label', 'promptLabel', 'hint', 'directives'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['presetName', 'categories'],
            additionalProperties: false,
        };
        if (options.generateDescriptions === false) {
            const item = schema.properties.categories.items.properties.directives.items;
            delete item.properties.description;
            item.required = item.required.filter(key => key !== 'description');
        }
        return schema;
    }

    function getResolvedMasterContext() {
        const resolved = substituteParams(MASTER_CONTEXT_TEMPLATE);

        return resolved
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => {
                if (!line) {
                    return false;
                }

                const parts = line.split(':');
                if (parts.length < 2) {
                    return true;
                }

                const value = parts.slice(1).join(':').trim();
                if (!value) {
                    return false;
                }

                if (/\{\{.+\}\}/.test(value)) {
                    return false;
                }

                return true;
            })
            .join('\n');
    }

    function inferMasterLanguage(sourceText) {
        const text = String(sourceText || '');
        const counters = {
            ru: (text.match(/[А-Яа-яЁё]/g) || []).length,
            ja: (text.match(/[\u3040-\u30ff\u31f0-\u31ff\u4e00-\u9faf]/g) || []).length,
            ko: (text.match(/[\uac00-\ud7af]/g) || []).length,
            en: (text.match(/[A-Za-z]/g) || []).length,
        };

        const sorted = Object.entries(counters).sort((a, b) => b[1] - a[1]);
        return sorted[0]?.[1] ? sorted[0][0] : 'en';
    }

    function getMasterLanguageMeta(languageCode) {
        const map = {
            ru: { code: 'ru', labelRu: 'русский', labelEn: 'Russian' },
            en: { code: 'en', labelRu: 'английский', labelEn: 'English' },
            ja: { code: 'ja', labelRu: 'японский', labelEn: 'Japanese' },
            ko: { code: 'ko', labelRu: 'корейский', labelEn: 'Korean' },
        };

        return map[languageCode] || map.en;
    }

    function buildMasterSystemPrompt(categories, languageMeta, userRequest = '', options = {}) {
        const categorySummary = categories
            .map((category) => `- ${category.id}: ${category.label}${category.hint ? ` (${category.hint})` : ''}`)
            .join('\n');

        const hasRequest = typeof userRequest === 'string' && userRequest.trim().length > 0;

        const lines = [
            'You are a scene-directing preset generator for roleplay chats.',
            'Return JSON only. No markdown, no prose, no explanations.',
            `Write presetName, category labels, category hints, directive names${options.generateDescriptions === false ? '' : ' and descriptions'} in ${languageMeta.labelEn}.`,
            'You may keep, remove, merge, rename, or add categories if it materially improves the preset.',
            'Return a complete preset tree in one response.',
        ];

        if (hasRequest) {
            lines.push(
                'IMPORTANT: The user has provided a specific creative request. This request is your TOP PRIORITY.',
                'Shape the entire preset — categories, directives, values, and preset name — to match the user\'s request first.',
                'Use character data as supporting context, but the user\'s creative direction takes precedence.',
            );
        }

        lines.push(
            getGenerationFocusInstruction(options.generationFocus),
            'Keep directive names short, reusable, concrete, and useful across several replies.',
            options.generateDescriptions === false
                ? 'Do not generate directive descriptions. Omit the description field; use concise directive names and intensity values. Keep category hints as interface help.'
                : 'Give every directive a non-empty description: 1-2 concise sentences explaining how to express its effect in the reply, not merely repeating its name. Maximum 1000 characters.',
            'Directive descriptions are sent to the roleplay model. Category hints are interface help only and are not included in the directing prompt.',
            'Use meaningful directive values from 55 to 90 in steps of 5.',
            'Do not use 0: generated directives must be active steering signals, not disabled placeholders.',
            'Avoid 50 unless the source clearly calls for a deliberately weak neutral influence.',
            'Set every directive active to true. Never generate inactive directives.',
            options.presetSize === 'compact'
                ? 'Return a compact preset: 2 to 3 categories and 4 to 6 directives total. Keep only the strongest distinct ideas.'
                : 'Return 3 to 7 categories and usually 6 to 14 directives total.',
            'Prefer 1 to 4 directives per category.',
            'Avoid duplicates, synonyms, and filler.',
            'Directives must shape tone, pacing, framing, conflict, intimacy, escalation, and scene movement.',
            'Do not mention the source text inside directive names.',
            'If data is missing, omit weak ideas instead of inventing filler.',
            'Category ids must be short lowercase slugs using latin letters, numbers, or hyphens.',
            'Every directive must live inside its category.directives array.',
            'Current categories to consider as input, not as a hard limit:',
            categorySummary || '- none',
            'Schema reminder:',
            '{',
            '  "presetName": "short preset name",',
            '  "categories": [',
            '    {',
            '      "id": "category-slug",',
            '      "label": "category label",',
            '      "promptLabel": "short uppercase-ready label",',
            '      "hint": "short category description",',
            '      "directives": [',
            '        {',
            '          "name": "short directive name",',
            ...(options.generateDescriptions === false ? [] : ['          "description": "how this directive should shape the reply",']),
            '          "value": 70,',
            '          "active": true',
            '        }',
            '      ]',
            '    }',
            '  ]',
            '}',
        );

        return lines.join('\n');
    }

    function buildMasterMessages(userRequest = '', options = {}) {
        const sourceText = getResolvedMasterContext();
        const categories = getCategories();
        const languageMeta = getMasterLanguageMeta(inferMasterLanguage(sourceText));
        const categoryLines = categories
            .map((category) => `- ${category.id} (${category.label}): ${category.hint || 'без подсказки'}`)
            .join('\n');

        const hasRequest = typeof userRequest === 'string' && userRequest.trim().length > 0;
        const trimmedRequest = hasRequest ? userRequest.trim() : '';

        const userPromptParts = [
            'Собери пресет Scene Director для ролевого чата.',
            `Язык результата: ${languageMeta.labelRu} (${languageMeta.code}).`,
            'Собери его за один ответ, как полноценное дерево категорий и директив.',
            'Ты можешь оставить подходящие категории, удалить лишние, объединить похожие и добавить новые, если это сделает пресет сильнее.',
        ];

        if (hasRequest) {
            userPromptParts.push(
                '',
                '### ГЛАВНЫЙ ПРИОРИТЕТ ПОЛЬЗОВАТЕЛЯ ###',
                `Пользователь просит: ${trimmedRequest}`,
                'Это — основное пожелание. Весь пресет должен в первую очередь отражать этот запрос.',
                'Адаптируй категории, директивы и их значения под этот запрос. Данные персонажа используй как контекст для адаптации, но приоритет — пожелание пользователя.',
                '',
            );
        }

        userPromptParts.push(
            'Подумай, какие акценты реально помогут сцене: тон, близость, энергия, конфликт, развитие, твисты, атмосферу, ритм.',
            'Не делай мусорных или слишком общих директив. Лучше меньше, но точнее.',
            'Верни только итоговый JSON-объект, без пояснений.',
            '',
            'Текущие категории в интерфейсе:',
            categoryLines,
            '',
            'Данные о персонаже и пользователе:',
            sourceText || '(данных недостаточно)',
        );

        const systemPrompt = buildMasterSystemPrompt(categories, languageMeta, trimmedRequest, options);

        return {
            sourceText,
            systemPrompt,
            userPrompt: userPromptParts.join('\n'),
        };
    }

    function getMasterFallbackPresetName(sourceText) {
        const match = String(sourceText || '').match(/Имя персонажа:\s*(.+)/i);
        const charName = String(match?.[1] || '').trim();
        if (charName) {
            return `Scene Director: ${charName.slice(0, 48)}`;
        }

        return 'Scene Director Preset';
    }

    function buildMasterCategoryRawMessages(category, options = {}) {
        const sourceText = getResolvedMasterContext();
        const languageMeta = getMasterLanguageMeta(inferMasterLanguage(sourceText));
        const {
            slotIndex = 0,
            targetCount = getFallbackCategoryTargetCount(category.id),
            existingItems = [],
        } = options;
        const usedNames = existingItems
            .map((item) => String(item?.name || '').trim())
            .filter(Boolean)
            .join('; ');
        const systemPrompt = [
            'You create Scene Director directives for one category in a roleplay preset.',
            getGenerationFocusInstruction(options.generationFocus),
            'Return plain text only. No JSON. No markdown. No explanations.',
            `Write the directive name${options.generateDescriptions === false ? '' : ' and description'} in ${languageMeta.labelEn}.`,
            'Output exactly one directive in exactly one line in this format:',
            `ITEM|${category.id}|70|short directive name|true${options.generateDescriptions === false ? '' : '|concise directive description'}`,
            'Rules:',
            `- Use only the category "${category.id}".`,
            '- Return exactly one ITEM line.',
            '- Start immediately with ITEM| on the first line.',
            '- No preset name line.',
            '- Directive names must be short, concrete, reusable, and without quotes or pipe symbols.',
            options.generateDescriptions === false
                ? '- Do not generate a description; end the line after true.'
                : '- Include a non-empty description of how to express the directive in a reply: 1-2 concise sentences, at most 1000 characters, without pipe symbols or line breaks.',
            '- Values must be integers from 0 to 100 in steps of 5.',
            '- Prefer values from 55 to 90. Do not use 0 or 50 for generated directives.',
            '- Generated directives are always active; do not output inactive/off/false.',
            '- Avoid duplicates, filler, and generic wording.',
            '- Make directives materially useful for steering replies.',
            '- Do not repeat already used directives.',
        ].join('\n');

        const userPrompt = [
            `Собери директивы только для категории ${category.id}.`,
            `Язык результата: ${languageMeta.labelRu} (${languageMeta.code}).`,
            `Категория ${category.id} / ${category.label}: ${category.hint || 'без описания'}.`,
            `Сейчас нужен слот ${slotIndex + 1} из ${targetCount} для этой категории.`,
            'Нужна одна сильная директива именно для этой категории.',
            'Не повторяй соседние идеи разными словами.',
            usedNames ? `Уже использованные директивы этой категории: ${usedNames}` : 'Пока в этой категории ещё нет выбранных директив.',
            '',
            'Полный контекст персонажа и пользователя:',
            sourceText || '(данных недостаточно)',
        ].join('\n');

        return {
            sourceText,
            systemPrompt,
            userPrompt,
        };
    }

    return {
        buildMasterCategoryRawMessages,
        buildMasterMessages,
        buildMasterPresetJsonSchema,
        buildMasterSystemPrompt,
        getFallbackCategoryTargetCount,
        getMasterFallbackPresetName,
        getMasterLanguageMeta,
        getResolvedMasterContext,
        inferMasterLanguage,
    };
}
