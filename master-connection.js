import { getRequestHeaders } from '../../../../script.js';
import { chat_completion_sources } from '../../../openai.js';

export function buildCustomHeadersYaml(apiKey) {
    const trimmed = String(apiKey || '').trim();
    if (!trimmed) {
        return '';
    }

    const authValue = trimmed.startsWith('Bearer ') ? trimmed : `Bearer ${trimmed}`;
    return `Authorization: ${JSON.stringify(authValue)}`;
}

export function createMasterApiHeaders(apiKey, { includeJson = false } = {}) {
    const headers = {};
    const trimmed = String(apiKey || '').trim();

    if (includeJson) {
        headers['Content-Type'] = 'application/json';
    }

    if (trimmed) {
        headers.Authorization = trimmed.startsWith('Bearer ') ? trimmed : `Bearer ${trimmed}`;
    }

    return headers;
}

export function buildMasterBackendPayload(url, apiKey, normalizeBaseUrl) {
    return {
        chat_completion_source: chat_completion_sources.CUSTOM,
        custom_url: normalizeBaseUrl(url),
        custom_include_headers: buildCustomHeadersYaml(apiKey),
    };
}

export function createTimedAbortController(timeoutMs, timeoutMessage) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
        controller.abort(timeoutMessage);
    }, timeoutMs);

    return {
        controller,
        cleanup() {
            window.clearTimeout(timeoutId);
        },
    };
}

export function isAbortLikeError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || error || '').toLowerCase();

    return name === 'AbortError'
        || message.includes('aborted')
        || message.includes('abort')
        || message.includes('отмен')
        || message.includes('cancel');
}

export async function readJsonResponseOrEmpty(response) {
    try {
        return await response.json();
    } catch {
        return {};
    }
}

export function extractMasterApiError(response, responseData, fallbackMessage) {
    return responseData?.message
        || responseData?.error?.message
        || response.statusText
        || fallbackMessage;
}

export function getMasterConnectionDetails(master, normalizeBaseUrl) {
    const url = normalizeBaseUrl(master?.url);
    const model = String(master?.model || '').trim();

    if (!url) {
        throw new Error('Укажи URL подключения.');
    }

    return {
        url,
        apiKey: String(master?.apiKey || ''),
        model,
    };
}

export async function fetchMasterModelsDirect(url, apiKey, signal = undefined) {
    const response = await fetch(`${url}/models`, {
        method: 'GET',
        headers: createMasterApiHeaders(apiKey),
        signal,
    });
    const responseData = await readJsonResponseOrEmpty(response);

    if (!response.ok) {
        throw new Error(extractMasterApiError(response, responseData, 'Не удалось загрузить список моделей.'));
    }

    return extractModelIds(responseData);
}

export async function fetchMasterModelsViaBackend(url, apiKey, signal = undefined, normalizeBaseUrl) {
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        signal,
        body: JSON.stringify(buildMasterBackendPayload(url, apiKey, normalizeBaseUrl)),
    });
    const responseData = await readJsonResponseOrEmpty(response);

    if (!response.ok || responseData?.error) {
        throw new Error(extractMasterApiError(response, responseData, 'Не удалось проверить подключение через SillyTavern.'));
    }

    return extractModelIds(responseData);
}

export function extractMasterResponseContent(responseData) {
    if (!responseData || typeof responseData !== 'object') {
        return '';
    }

    const messageContent = responseData?.choices?.[0]?.message?.content;
    if (Array.isArray(messageContent)) {
        return messageContent
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }

                if (part && typeof part === 'object') {
                    return String(part.text || part.content || '');
                }

                return '';
            })
            .join('')
            .trim();
    }

    if (typeof messageContent === 'string') {
        return messageContent.trim();
    }

    if (messageContent && typeof messageContent === 'object') {
        return String(messageContent.text || messageContent.content || '').trim();
    }

    const textContent = responseData?.choices?.[0]?.text;
    if (typeof textContent === 'string') {
        return textContent.trim();
    }

    if (typeof responseData.content === 'string') {
        return responseData.content.trim();
    }

    return '';
}

export function describeMasterResponseSnippet(rawResponse) {
    if (typeof rawResponse === 'string') {
        return rawResponse.slice(0, 1200);
    }

    try {
        return JSON.stringify(rawResponse, null, 2).slice(0, 1200);
    } catch {
        return String(rawResponse || '').slice(0, 1200);
    }
}

export function shouldRetryMasterGeneration(error, rawResponse, attemptNumber, maximumAttempts = 2) {
    if (attemptNumber >= maximumAttempts) {
        return false;
    }

    const message = String(error?.message || '');
    if (!message) {
        return false;
    }

    if (!/Собранный пресет слишком слабый|Не удалось распарсить JSON ответа модели|нет пригодных директив/i.test(message)) {
        return false;
    }

    return typeof rawResponse === 'string' && rawResponse.trim().length > 0;
}

export async function requestMasterPresetDirect({ url, apiKey, model, messages, maxTokens, temperature, signal }) {
    const headers = createMasterApiHeaders(apiKey, { includeJson: true });
    const basePayload = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
    };
    const attempts = [
        { ...basePayload, max_completion_tokens: maxTokens, max_output_tokens: maxTokens },
        { ...basePayload, max_completion_tokens: maxTokens },
        basePayload,
    ];
    let lastError = null;

    for (const payload of attempts) {
        const response = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers,
            signal,
            body: JSON.stringify(payload),
        });

        const responseData = await readJsonResponseOrEmpty(response);
        if (response.ok) {
            return extractMasterResponseContent(responseData) || responseData;
        }

        lastError = new Error(extractMasterApiError(response, responseData, 'Не удалось получить ответ от кастомной модели.'));
        const message = String(lastError.message || '');
        const looksLikeTokenFieldIssue = /max_completion_tokens|max_tokens|unknown|unexpected|unsupported/i.test(message);

        if (!looksLikeTokenFieldIssue || payload === basePayload) {
            throw lastError;
        }
    }

    throw lastError || new Error('Не удалось получить ответ от кастомной модели.');
}

export async function requestMasterPresetViaBackend({
    context,
    url,
    apiKey,
    model,
    messages,
    maxTokens,
    temperature,
    signal,
    normalizeBaseUrl,
    jsonSchema = null,
}) {
    const requestPayload = {
        stream: false,
        messages,
        model,
        max_tokens: maxTokens,
        temperature,
        ...buildMasterBackendPayload(url, apiKey, normalizeBaseUrl),
    };

    if (jsonSchema) {
        requestPayload.json_schema = jsonSchema;
    }

    const response = await context.ChatCompletionService.processRequest(requestPayload, {}, true, signal);

    return response?.content ?? response;
}

export function extractModelIds(responseData) {
    const rawModels = Array.isArray(responseData?.data)
        ? responseData.data
        : Array.isArray(responseData?.models)
            ? responseData.models
            : Array.isArray(responseData)
                ? responseData
                : [];

    return [...new Set(rawModels
        .map((item) => {
            if (typeof item === 'string') {
                return item;
            }

            if (item && typeof item === 'object') {
                if (typeof item.id === 'string') {
                    return item.id;
                }

                if (typeof item.name === 'string') {
                    return item.name;
                }
            }

            return '';
        })
        .map((item) => item.trim())
        .filter(Boolean))];
}
