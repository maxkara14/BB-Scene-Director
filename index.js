import { setExtensionPrompt, extension_prompt_roles, extension_prompt_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = "BB-Scene-Director";

// Дефолтные настройки
if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = {
        directives:[
            { id: Date.now(), name: "Экшен / Динамика", value: 5, active: false },
            { id: Date.now() + 1, name: "Драма / Эмоции", value: 5, active: false },
            { id: Date.now() + 2, name: "Жестокость (Gore)", value: 0, active: false }
        ],
        useMacro: false
    };
}

// === ГЕНЕРАЦИЯ ТЕКСТА ПРОМПТА ===
function getDirectorPromptText() {
    const directives = extension_settings[MODULE_NAME].directives;
    const activeDirectives = directives.filter(d => d.active);

    if (activeDirectives.length === 0) return "";

    let prompt = `[SCENE DIRECTION: Adhere strictly to the following stylistic directives and intensity levels for your narration]\n`;
    
    activeDirectives.forEach(d => {
        let intensityDesc = "";
        if (d.value === 0) intensityDesc = "(CRITICAL: DO NOT USE THIS. ABSOLUTELY ZERO FOCUS)";
        else if (d.value <= 3) intensityDesc = "(Mild / Subtle elements)";
        else if (d.value <= 7) intensityDesc = "(Moderate / Noticeable focus)";
        else intensityDesc = "(EXTREME / PRIMARY FOCUS OF THE SCENE)";

        prompt += `- ${d.name}: ${d.value}/10 ${intensityDesc}\n`;
    });

    return prompt;
}

// === ИНЪЕКЦИЯ ПРОМПТА ===
function updateDirectorPrompt() {
    const promptText = getDirectorPromptText();

    // Обновляем визуальный лог в панели
    const previewBox = $('#bb-dir-preview-text');
    if (previewBox.length) {
        previewBox.text(promptText ? promptText : "Нет активных стилей (Промпт пуст).");
    }

    if (extension_settings[MODULE_NAME].useMacro) {
        // Если юзаем макрос, отключаем авто-инъекцию
        setExtensionPrompt('bb_scene_director', '', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    } else {
        // Авто-инъекция перед сообщением
        setExtensionPrompt('bb_scene_director', promptText, extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    }
}

// === ОТРИСОВКА ИНТЕРФЕЙСА ===
function renderDirectorHud() {
    const container = $('#bb-dir-list');
    container.empty();

    const directives = extension_settings[MODULE_NAME].directives;

    directives.forEach((d, index) => {
        const eyeIcon = d.active ? 'fa-eye' : 'fa-eye-slash';
        const eyeColor = d.active ? '#c084fc' : '#64748b';
        const cardOpacity = d.active ? '1' : '0.5';

        const html = `
            <div class="bb-dir-card" style="opacity: ${cardOpacity};" data-index="${index}">
                <div class="bb-dir-header">
                    <input type="text" class="bb-dir-name text_pole" value="${d.name}" placeholder="Название стиля...">
                    <div style="display:flex; gap:8px;">
                        <i class="fa-solid ${eyeIcon} bb-dir-toggle" style="color: ${eyeColor}; cursor:pointer;" title="Вкл/Выкл"></i>
                        <i class="fa-solid fa-trash bb-dir-delete" style="color: #ef4444; cursor:pointer;" title="Удалить"></i>
                    </div>
                </div>
                <div class="bb-dir-slider-row">
                    <span style="font-size: 10px; color:#94a3b8; font-weight:bold;">0</span>
                    <input type="range" class="bb-dir-slider" min="0" max="10" value="${d.value}">
                    <span class="bb-dir-val-display" style="font-weight:900; color:#fff; width:20px; text-align:right;">${d.value}</span>
                </div>
            </div>
        `;
        container.append(html);
    });
}

// === НАСТРОЙКИ ВО ВКЛАДКЕ РАСШИРЕНИЙ ===
function setupExtensionSettings() {
    if (document.getElementById('bb-director-settings-wrapper')) return;
    
    const s = extension_settings[MODULE_NAME];
    
    const settingsHtml = `
        <div id="bb-director-settings-wrapper" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎬 BB Scene Director</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 10px;">
                <label class="checkbox_label" style="margin-top: 5px;">
                    <input type="checkbox" id="bb-dir-cfg-usemacro" ${s.useMacro ? 'checked' : ''}>
                    <span>Использовать макрос <code>{{bb_scene}}</code></span>
                </label>
                <span style="font-size: 10px; color: #94a3b8; line-height: 1.2; margin-bottom: 5px; display:block;">
                    * Если включено, расширение перестанет автоматически вставлять инструкции в чат. Вам нужно будет вручную вписать макрос <code>{{bb_scene}}</code> в ваш пресет или системный промпт.
                </span>
            </div>
        </div>
    `;
    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.insertAdjacentHTML('beforeend', settingsHtml);

    $('#bb-dir-cfg-usemacro').on('change', function() {
        extension_settings[MODULE_NAME].useMacro = $(this).is(':checked');
        saveSettingsDebounced();
        updateDirectorPrompt();
    });
}

// === СОЗДАНИЕ ПАНЕЛИ ===
function ensureDirectorHud() {
    if (document.getElementById('bb-director-hud')) return;

    const hudHtml = `
        <div id="bb-director-hud">
            <div id="bb-director-toggle" title="Режиссёр Сцены (Стиль игры)">
                <i class="fa-solid fa-clapperboard"></i>
                <i class="fa-solid fa-chevron-right" id="bb-dir-arrow" style="font-size: 10px; margin-top: 5px;"></i>
            </div>
            <div class="bb-dir-title">🎬 Режиссёр Сцены</div>
            
            <div id="bb-dir-list"></div>
            
            <div style="padding: 15px; border-top: 1px solid rgba(255,255,255,0.1);">
                <button id="bb-dir-add-btn" class="menu_button interactable" style="width: 100%; margin-bottom: 15px;">
                    <i class="fa-solid fa-plus"></i>&nbsp; Добавить стиль
                </button>
                
                <div class="bb-dir-log-container">
                    <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase; font-weight: bold; margin-bottom: 5px;">
                        <i class="fa-solid fa-terminal"></i> Текущая инструкция ИИ:
                    </div>
                    <div id="bb-dir-preview-text" style="font-size: 10px; color: #cbd5e1; font-family: monospace; white-space: pre-wrap; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 2px solid #c084fc; max-height: 150px; overflow-y: auto;"></div>
                </div>
            </div>
        </div>
    `;
    $('body').append(hudHtml);

    $('#bb-director-toggle').on('click', function() {
        const hud = $('#bb-director-hud');
        hud.toggleClass('open');
        if (hud.hasClass('open')) {
            $('#bb-dir-arrow').removeClass('fa-chevron-right').addClass('fa-chevron-left');
        } else {
            $('#bb-dir-arrow').removeClass('fa-chevron-left').addClass('fa-chevron-right');
        }
    });

    $('#bb-dir-list')
        .on('input', '.bb-dir-slider', function() {
            const index = $(this).closest('.bb-dir-card').data('index');
            const val = parseInt($(this).val());
            $(this).siblings('.bb-dir-val-display').text(val);
            extension_settings[MODULE_NAME].directives[index].value = val;
            saveSettingsDebounced();
            updateDirectorPrompt();
        })
        .on('click', '.bb-dir-toggle', function() {
            const index = $(this).closest('.bb-dir-card').data('index');
            extension_settings[MODULE_NAME].directives[index].active = !extension_settings[MODULE_NAME].directives[index].active;
            saveSettingsDebounced();
            renderDirectorHud();
            updateDirectorPrompt();
        })
        .on('click', '.bb-dir-delete', function() {
            const index = $(this).closest('.bb-dir-card').data('index');
            extension_settings[MODULE_NAME].directives.splice(index, 1);
            saveSettingsDebounced();
            renderDirectorHud();
            updateDirectorPrompt();
        })
        .on('change', '.bb-dir-name', function() {
            const index = $(this).closest('.bb-dir-card').data('index');
            extension_settings[MODULE_NAME].directives[index].name = $(this).val();
            saveSettingsDebounced();
            updateDirectorPrompt();
        });

    $('#bb-dir-add-btn').on('click', function() {
        extension_settings[MODULE_NAME].directives.push({
            id: Date.now(),
            name: "Новый стиль",
            value: 5,
            active: true
        });
        saveSettingsDebounced();
        renderDirectorHud();
        updateDirectorPrompt();
    });

    renderDirectorHud();
    updateDirectorPrompt();
}

jQuery(async () => {
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        
        // Регистрация макроса
        const context = SillyTavern.getContext();
        if (context.registerMacro) {
            context.registerMacro('bb_scene', () => {
                return extension_settings[MODULE_NAME].useMacro ? getDirectorPromptText() : '';
            });
        }

        eventSource.on(event_types.APP_READY, () => {
            setupExtensionSettings();
            ensureDirectorHud();
        });

        // Замена макроса в промптах
        eventSource.on(event_types.GENERATE_AFTER_DATA, (generate_data) => {
            if (extension_settings[MODULE_NAME].useMacro && generate_data && Array.isArray(generate_data.messages)) {
                const promptText = getDirectorPromptText();
                generate_data.messages.forEach(msg => {
                    if (msg && msg.content && typeof msg.content === 'string' && msg.content.includes('{{bb_scene}}')) {
                        msg.content = msg.content.replace(/\{\{bb_scene\}\}/g, promptText);
                    }
                });
            }
        });

    } catch (e) {
        console.error("[BB Scene Director] Ошибка:", e);
    }
});