export function createMasterPresetParser({
    createCategoryRecord,
    dedupePresetItems,
    getCategories,
    getDirectives,
    masterMinimumCategoryCount = 3,
    masterMinimumDirectiveCount = 5,
    normalizeCategories,
    normalizeCategoryId,
    normalizePresetItem,
}) {
    const getCurrentCategories = () => Array.isArray(getCategories?.()) ? getCategories() : [];
    const getDirectiveMap = () => new Map(
        (Array.isArray(getDirectives?.()) ? getDirectives() : [])
            .map((directive) => [directive.name.toLowerCase(), directive]),
    );

    function cleanupMarkdownFences(rawText) {
        return String(rawText || '')
            .replace(/```(?:json)?/gi, '')
            .replace(/```/g, '')
            .trim();
    }

    function extractBalancedSegment(rawText, openChar = '{', closeChar = '}') {
        const source = String(rawText || '');
        let start = -1;
        let depth = 0;
        let inString = false;
        let escapeNext = false;

        for (let index = 0; index < source.length; index++) {
            const char = source[index];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (char === openChar) {
                if (start === -1) {
                    start = index;
                }
                depth += 1;
                continue;
            }

            if (char === closeChar && depth > 0) {
                depth -= 1;
                if (start !== -1 && depth === 0) {
                    return source.slice(start, index + 1);
                }
            }
        }

        return '';
    }

    function extractJsonCandidate(rawText) {
        const text = cleanupMarkdownFences(rawText);
        const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fencedMatch?.[1]) {
            return fencedMatch[1].trim();
        }

        const objectCandidate = extractBalancedSegment(text, '{', '}');
        if (objectCandidate) {
            return objectCandidate.trim();
        }

        return text;
    }

    function quoteBareJsonObjectKeys(rawText) {
        return String(rawText || '').replace(/([{,]\s*)([A-Za-zА-Яа-я_][\wА-Яа-я-]*)(\s*:)/g, '$1"$2"$3');
    }

    function stripJsonLikeComments(rawText) {
        const source = String(rawText || '');
        let result = '';
        let inString = false;
        let escapeNext = false;

        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            const next = source[index + 1];

            if (escapeNext) {
                result += char;
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                result += char;
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                result += char;
                inString = !inString;
                continue;
            }

            if (!inString && char === '/' && next === '/') {
                while (index < source.length && source[index] !== '\n') {
                    index += 1;
                }

                if (index < source.length) {
                    result += '\n';
                }
                continue;
            }

            if (!inString && char === '/' && next === '*') {
                index += 2;
                while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
                    index += 1;
                }
                index += 1;
                continue;
            }

            result += char;
        }

        return result;
    }

    function escapeUnescapedJsonStringChars(rawText) {
        const source = String(rawText || '');
        let result = '';
        let inString = false;
        let escapeNext = false;

        for (let index = 0; index < source.length; index++) {
            const char = source[index];

            if (escapeNext) {
                result += char;
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                result += char;
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                result += char;
                inString = !inString;
                continue;
            }

            if (inString) {
                if (char === '\n') {
                    result += '\\n';
                    continue;
                }

                if (char === '\r') {
                    result += '\\r';
                    continue;
                }

                if (char === '\t') {
                    result += '\\t';
                    continue;
                }
            }

            result += char;
        }

        return result;
    }

    function repairJsonCandidate(rawText) {
        return escapeUnescapedJsonStringChars(
            stripJsonLikeComments(
                cleanupMarkdownFences(rawText),
            )
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .replace(/[“”]/g, '"')
                .replace(/[‘’]/g, "'")
                .replace(/\bTrue\b/g, 'true')
                .replace(/\bFalse\b/g, 'false')
                .replace(/\bNone\b/g, 'null')
                .replace(/,\s*([\]}])/g, '$1')
                .trim(),
        );
    }

    function convertSingleQuotedStringsToDoubleJson(rawText) {
        const source = String(rawText || '');
        let result = '';
        let inSingle = false;
        let inDouble = false;
        let escapeNext = false;

        for (let index = 0; index < source.length; index++) {
            const char = source[index];

            if (escapeNext) {
                result += char;
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                result += char;
                escapeNext = true;
                continue;
            }

            if (char === '"' && !inSingle) {
                result += char;
                inDouble = !inDouble;
                continue;
            }

            if (char === '\'' && !inDouble) {
                result += '"';
                inSingle = !inSingle;
                continue;
            }

            if (inSingle && char === '"') {
                result += '\\"';
                continue;
            }

            result += char;
        }

        return result;
    }

    function insertMissingJsonCommas(rawText) {
        return String(rawText || '')
            .replace(
                /("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\]}])(\s*)(?="(?:\\.|[^"\\])*"\s*:)/g,
                '$1,$2',
            )
            .replace(
                /("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\]}])(\s*)(?=[{\[])/g,
                '$1,$2',
            );
    }

    function balanceJsonClosers(rawText) {
        const source = String(rawText || '');
        const closers = [];
        let inString = false;
        let escapeNext = false;

        for (let index = 0; index < source.length; index++) {
            const char = source[index];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (char === '{') {
                closers.push('}');
                continue;
            }

            if (char === '[') {
                closers.push(']');
                continue;
            }

            if ((char === '}' || char === ']') && closers.length) {
                const expected = closers[closers.length - 1];
                if (char === expected) {
                    closers.pop();
                }
            }
        }

        return `${source}${closers.reverse().join('')}`;
    }

    function repairLooseJsonCandidate(rawText) {
        return balanceJsonClosers(
            insertMissingJsonCommas(
                escapeUnescapedJsonStringChars(
                    convertSingleQuotedStringsToDoubleJson(
                        quoteBareJsonObjectKeys(
                            repairJsonCandidate(rawText),
                        ),
                    ).replace(/,\s*([\]}])/g, '$1'),
                ),
            ),
        );
    }

    function normalizeParsedMasterObject(parsed) {
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }

        if (Array.isArray(parsed)) {
            return parsed.find((item) => item && typeof item === 'object' && !Array.isArray(item)) || null;
        }

        return null;
    }

    function normalizeMasterCategoryOutput(rawCategory, index = 0) {
        if (!rawCategory || typeof rawCategory !== 'object') {
            return null;
        }

        const category = createCategoryRecord({
            id: rawCategory.id || rawCategory.key || rawCategory.slug || rawCategory.category,
            label: rawCategory.label || rawCategory.name,
            promptLabel: rawCategory.promptLabel || rawCategory.prompt_label || rawCategory.label || rawCategory.name,
            hint: rawCategory.hint || rawCategory.description || rawCategory.summary || '',
        }, index);

        const directives = (Array.isArray(rawCategory.directives)
            ? rawCategory.directives
            : Array.isArray(rawCategory.items)
                ? rawCategory.items
                : [])
            .filter((directive) => directive && typeof directive === 'object' && String(directive.name || '').trim());

        return {
            category,
            directives,
        };
    }

    function decodeJsonStringFragment(value) {
        try {
            return JSON.parse(`"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        } catch {
            return String(value || '')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
        }
    }

    function extractJsonLikeStringValue(rawText, keyName) {
        const pattern = new RegExp(`["']${keyName}["']\\s*:\\s*["']((?:\\\\.|[^"'\\\\])*)["']`, 'i');
        const match = String(rawText || '').match(pattern);
        if (!match?.[1]) {
            return '';
        }

        return decodeJsonStringFragment(match[1]).trim();
    }

    function extractCompletedObjectsFromArray(rawText, keyName) {
        const text = String(rawText || '');
        const keyPattern = new RegExp(`["']${keyName}["']\\s*:`);
        const keyMatch = keyPattern.exec(text);
        if (!keyMatch) {
            return [];
        }

        const arrayStart = text.indexOf('[', keyMatch.index);
        if (arrayStart === -1) {
            return [];
        }

        const objects = [];
        let objectStart = -1;
        let depth = 0;
        let inString = false;
        let escapeNext = false;

        for (let index = arrayStart + 1; index < text.length; index++) {
            const char = text[index];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (char === '{') {
                if (depth === 0) {
                    objectStart = index;
                }
                depth += 1;
                continue;
            }

            if (char === '}') {
                if (depth > 0) {
                    depth -= 1;
                    if (depth === 0 && objectStart !== -1) {
                        objects.push(text.slice(objectStart, index + 1));
                        objectStart = -1;
                    }
                }
                continue;
            }

            if (char === ']' && depth === 0) {
                break;
            }
        }

        return objects;
    }

    function salvagePartialMasterPreset(rawText) {
        const preparedCandidates = [
            repairLooseJsonCandidate(rawText),
            repairJsonCandidate(rawText),
            cleanupMarkdownFences(rawText),
        ].filter((value, index, array) => {
            const text = String(value || '').trim();
            return text && array.findIndex((item) => item === value) === index;
        });

        for (const candidate of preparedCandidates) {
            const presetName = extractJsonLikeStringValue(candidate, 'presetName')
                || extractJsonLikeStringValue(candidate, 'name')
                || 'Мастер-пресет';
            const categoryObjects = extractCompletedObjectsFromArray(candidate, 'categories');

            if (!categoryObjects.length) {
                continue;
            }

            const categories = [];
            const directives = [];

            for (const categoryText of categoryObjects) {
                const variants = [
                    categoryText,
                    repairLooseJsonCandidate(categoryText),
                    repairJsonCandidate(categoryText),
                ].filter((value, index, array) => array.indexOf(value) === index);

                for (const variant of variants) {
                    try {
                        const parsedCategory = JSON.parse(variant);
                        const normalizedCategory = normalizeMasterCategoryOutput(parsedCategory, categories.length);
                        if (!normalizedCategory) {
                            continue;
                        }

                        categories.push(normalizedCategory.category);
                        normalizedCategory.directives.forEach((directive) => {
                            directives.push({
                                ...directive,
                                category: normalizedCategory.category.id,
                            });
                        });
                        break;
                    } catch {
                        // Try the next repaired variant for this category chunk.
                    }
                }
            }

            if (categories.length && directives.length) {
                return {
                    presetName,
                    partial: true,
                    categories: categories.map((category) => ({
                        ...category,
                        directives: directives
                            .filter((directive) => directive.category === category.id)
                            .map((directive) => ({
                                name: directive.name,
                                value: directive.value,
                                active: directive.active !== false,
                            })),
                    })),
                };
            }
        }

        return null;
    }

    function normalizeMasterPresetPayload(parsed) {
        const object = normalizeParsedMasterObject(parsed);
        if (!object) {
            return null;
        }

        if (Array.isArray(object.directives)) {
            return {
                presetName: String(object.presetName || object.name || 'Мастер-пресет').trim() || 'Мастер-пресет',
                partial: Boolean(object.partial),
                categories: Array.isArray(object.categories) && object.categories.length
                    ? normalizeCategories(object.categories, object.directives, [])
                    : getCurrentCategories(),
                directives: object.directives,
            };
        }

        if (Array.isArray(object.categories)) {
            const categories = [];
            const items = [];
            let skippedCategoryCount = 0;

            object.categories.forEach((rawCategory, index) => {
                const normalizedCategory = normalizeMasterCategoryOutput(rawCategory, index);
                if (!normalizedCategory || !normalizedCategory.directives.length) {
                    skippedCategoryCount += 1;
                    return;
                }

                categories.push(normalizedCategory.category);
                normalizedCategory.directives.forEach((directive) => {
                    items.push({
                        ...directive,
                        category: normalizedCategory.category.id,
                    });
                });
            });

            return {
                presetName: String(object.presetName || object.name || 'Мастер-пресет').trim() || 'Мастер-пресет',
                partial: Boolean(object.partial) || skippedCategoryCount > 0,
                categories,
                directives: items,
            };
        }

        const sourceItems = Array.isArray(object.directives)
            ? object.directives
            : Array.isArray(object.items)
                ? object.items
                : [];

        return {
            presetName: String(object.presetName || object.name || 'Мастер-пресет').trim() || 'Мастер-пресет',
            partial: Boolean(object.partial),
            categories: getCurrentCategories(),
            directives: sourceItems,
        };
    }

    function parseMasterLineResponse(rawResponse) {
        const text = cleanupMarkdownFences(String(rawResponse || '')).replace(/\r/g, '').trim();
        if (!text) {
            throw new Error('Модель вернула пустой текстовый ответ.');
        }

        let presetName = '';
        const collectedItems = [];
        const categoryIds = getCurrentCategories().map((category) => category.id);
        const categoryPattern = new RegExp(`^(${categoryIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\|`, 'i');

        const parseLineTokens = (line) => line
            .split('|')
            .map((part) => String(part || '').trim())
            .filter(Boolean);

        for (const rawLine of text.split('\n')) {
            const line = String(rawLine || '').trim().replace(/^[*-]\s*/, '');
            if (!line) {
                continue;
            }

            const upperLine = line.toUpperCase();
            if (upperLine.startsWith('PRESET|')) {
                const [, ...rest] = parseLineTokens(line);
                presetName = rest.join(' | ').trim() || presetName;
                continue;
            }

            let tokens = [];
            if (upperLine.startsWith('ITEM|')) {
                tokens = parseLineTokens(line).slice(1);
            } else if (categoryPattern.test(line)) {
                tokens = parseLineTokens(line);
            } else {
                continue;
            }

            if (tokens.length < 3) {
                continue;
            }

            let category = '';
            let name = '';
            let value = '';
            let active = 'true';

            if (/^\d+%?$/i.test(tokens[1])) {
                [category, value, name, active = 'true'] = tokens;
            } else {
                [category, name, value, active = 'true'] = tokens;
            }

            collectedItems.push({
                category,
                name: String(name || '').replace(/["']/g, '').trim(),
                value: Number(String(value || '').replace(/[^\d.-]/g, '')),
                active: !/^(false|off|0|no)$/i.test(String(active || '').trim()),
            });
        }

        const items = dedupePresetItems(
            collectedItems
                .map((item) => normalizePresetItem(item, getDirectiveMap()))
                .filter(Boolean),
        );

        if (!items.length) {
            throw new Error('Модель не вернула ни одной пригодной ITEM-строки.');
        }

        return {
            presetName: presetName || 'Собранный пресет',
            items,
        };
    }

    function getMasterPresetQuality(items) {
        const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
        const categorySet = new Set(normalizedItems.map((item) => normalizeCategoryId(item.category, getCurrentCategories())));

        return {
            itemCount: normalizedItems.length,
            categoryCount: categorySet.size,
            categories: [...categorySet],
        };
    }

    function validateMasterPresetQuality(items, options = {}) {
        const quality = getMasterPresetQuality(items);
        const minimumCategoryCount = Math.min(masterMinimumCategoryCount, Math.max(1, getCurrentCategories().length));
        const partialMinimumCategoryCount = Math.min(2, Math.max(1, getCurrentCategories().length));
        const passesFullCheck = quality.itemCount >= masterMinimumDirectiveCount && quality.categoryCount >= minimumCategoryCount;
        const passesPartialCheck = Boolean(options.allowPartial)
            && quality.itemCount >= masterMinimumDirectiveCount
            && quality.categoryCount >= partialMinimumCategoryCount;

        if (!passesFullCheck && !passesPartialCheck) {
            throw new Error(`Собранный пресет слишком слабый: ${quality.itemCount} директив(ы), ${quality.categoryCount} категорий.`);
        }

        return quality;
    }

    function parseMasterPresetResponse(rawResponse) {
        let parsed = rawResponse;
        const rawText = typeof rawResponse === 'string' ? rawResponse : '';

        if (typeof parsed === 'string') {
            const cleaned = cleanupMarkdownFences(parsed);
            const candidates = [];
            const pushCandidate = (value) => {
                const text = String(value || '').trim();
                if (!text || candidates.includes(text)) {
                    return;
                }
                candidates.push(text);
            };

            pushCandidate(extractBalancedSegment(cleaned, '{', '}'));
            pushCandidate(extractJsonCandidate(cleaned));
            pushCandidate(cleaned);

            let parseError = 'Unknown JSON parse error';
            let parsedObject = null;

            for (const candidate of candidates) {
                const preparedVariants = [
                    candidate,
                    repairJsonCandidate(candidate),
                    repairLooseJsonCandidate(candidate),
                ].filter((value, index, array) => array.indexOf(value) === index);

                for (const prepared of preparedVariants) {
                    try {
                        const maybeParsed = JSON.parse(prepared);
                        const normalized = normalizeMasterPresetPayload(maybeParsed);
                        if (normalized) {
                            parsedObject = maybeParsed;
                            break;
                        }
                        parseError = 'JSON разобран, но объект пресета не найден.';
                    } catch (error) {
                        parseError = error?.message || 'Unknown JSON parse error';
                    }
                }

                if (parsedObject) {
                    break;
                }
            }

            if (!parsedObject) {
                const salvaged = salvagePartialMasterPreset(cleaned);
                if (salvaged) {
                    parsedObject = salvaged;
                }
            }

            if (!parsedObject) {
                throw new Error(`Не удалось распарсить JSON ответа модели: ${parseError}`);
            }

            parsed = parsedObject;
        }

        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Модель вернула пустой или неверный ответ.');
        }

        const normalizedPayload = normalizeMasterPresetPayload(parsed);
        if (!normalizedPayload) {
            throw new Error('Модель вернула объект, но структура пресета не распознана.');
        }

        const directivesByName = getDirectiveMap();
        const items = dedupePresetItems(
            normalizedPayload.directives
                .map((item) => normalizePresetItem(item, directivesByName))
                .filter(Boolean),
        );

        if (!items.length) {
            if (rawText) {
                const salvaged = salvagePartialMasterPreset(rawText);
                if (salvaged) {
                    const salvagedPayload = normalizeMasterPresetPayload(salvaged);
                    const salvagedItems = dedupePresetItems(
                        (salvagedPayload?.directives || [])
                            .map((item) => normalizePresetItem(item, directivesByName))
                            .filter(Boolean),
                    );

                    if (salvagedItems.length) {
                        return {
                            presetName: salvagedPayload.presetName,
                            partial: true,
                            categories: normalizeCategories(salvagedPayload.categories, salvagedItems, []),
                            items: salvagedItems,
                        };
                    }
                }
            }

            throw new Error('Модель вернула ответ, но в нём нет пригодных директив. Похоже, ответ был обрезан или искажён ещё до парсинга.');
        }

        return {
            presetName: normalizedPayload.presetName,
            partial: Boolean(normalizedPayload.partial),
            categories: normalizeCategories(normalizedPayload.categories, items, []),
            items,
        };
    }

    return {
        parseMasterLineResponse,
        parseMasterPresetResponse,
        validateMasterPresetQuality,
    };
}
