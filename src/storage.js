import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName, defaultSettings, CARD_FIELDS, LANGUAGES, RESETTABLE_SETTING_KEYS, DENSITY_LEVELS, SETTING_FIELDS, SUPPORTER_FACES, FONT_SCALES } from './constants.js';
import { PROMPT_SLOTS, LEGACY_PROMPT_KEYS } from './prompt-defaults.js';
import { state, log } from './state.js';

export function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    fillDefaults(extension_settings[extensionName]);
    migrateSettings(extension_settings[extensionName]);

    state.settings = extension_settings[extensionName];
    log('Settings loaded');
}

function fillDefaults(settings) {
    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(defaultSettings[key]);
        }
    }
    for (const [key, field] of Object.entries(CARD_FIELDS)) {
        if (field.always) continue;
        if (typeof settings.cardFields[key] !== 'boolean') settings.cardFields[key] = !!field.defaultOn;
    }
}

function migrateSettings(settings) {
    if (!LANGUAGES[settings.language]) settings.language = 'en';
    settings.manualCharacter = {
        name: String(settings.manualCharacter?.name || ''),
        description: String(settings.manualCharacter?.description || ''),
    };
    // 성별마다 표정별 이미지 (예전 형식: 성별마다 이미지 하나 → 기본 표정으로)
    const avatarSet = value => {
        if (typeof value === 'string') return value ? { neutral: value } : {};
        const set = {};
        for (const face of SUPPORTER_FACES) {
            if (typeof value?.[face.id] === 'string' && value[face.id]) set[face.id] = value[face.id];
        }
        return set;
    };
    settings.supporterAvatars = {
        female: avatarSet(settings.supporterAvatars?.female),
        male: avatarSet(settings.supporterAvatars?.male),
    };
    settings.manualPersona = {
        name: String(settings.manualPersona?.name || ''),
        description: String(settings.manualPersona?.description || ''),
    };
    settings.botNotes = {
        name: String(settings.botNotes?.name || ''),
        description: String(settings.botNotes?.description || ''),
    };
    if (!['persona', 'bot'].includes(settings.forgeMode)) settings.forgeMode = 'persona';
    // 밀도 조절 켜기/끄기(구버전) → 분량 선택
    if ('concise' in settings) {
        if (settings.concise === true && settings.density === 'default') settings.density = 'concise';
        delete settings.concise;
    }
    if (!DENSITY_LEVELS[settings.density]) settings.density = 'default';
    if (!FONT_SCALES[settings.uiFontSize]) settings.uiFontSize = 'medium';
    if (!FONT_SCALES[settings.chatFontSize]) settings.chatFontSize = 'medium';
    if (!['pretendard', 'theme'].includes(settings.uiFontFamily)) settings.uiFontFamily = 'pretendard';
    // 세계관 항목: 기본 항목 또는 직접 추가한 항목만 (고른 순서 유지)
    if (!settings.settingFieldDefinitions || typeof settings.settingFieldDefinitions !== 'object') settings.settingFieldDefinitions = {};
    settings.settingFields = [...new Set(Array.isArray(settings.settingFields) ? settings.settingFields : [])]
        .filter(id => SETTING_FIELDS[id] || settings.settingFieldDefinitions[id]);

    const legacy = [];
    const oldCustom = {};
    for (const key of LEGACY_PROMPT_KEYS) {
        if (Object.hasOwn(settings.customPrompts, key)) {
            oldCustom[key] = String(settings.customPrompts[key] ?? '');
            delete settings.customPrompts[key];
        }
    }
    if (Object.keys(oldCustom).length) legacy.push({ name: '적용 중이던 수정본', prompts: oldCustom });
    const olderSystem = settings.customSystemPrompt?.trim();
    if (olderSystem && olderSystem !== oldCustom.system?.trim()) {
        legacy.push({ name: '이전 시스템 프롬프트 수정본', prompts: { system: olderSystem } });
    }

    settings.promptPresets = (settings.promptPresets || []).filter(p => p && p.name).filter(preset => {
        const prompts = preset.prompts || (preset.prompt ? { system: String(preset.prompt) } : {});
        if (Object.keys(prompts).some(key => LEGACY_PROMPT_KEYS.includes(key))) {
            legacy.push({ name: `프리셋: ${preset.name}`, prompts });
            return false;
        }
        preset.prompts = prompts;
        return true;
    });

    // 같은 내용이 이미 보관돼 있으면 건너뜀 (옛 버전이 열린 다른 창이 설정을 다시 저장한 경우 등)
    settings.legacyPrompts ||= [];
    const known = new Set(settings.legacyPrompts.map(set => JSON.stringify(set.prompts)));
    const fresh = legacy.filter(set => !known.has(JSON.stringify(set.prompts)));
    if (fresh.length) {
        settings.legacyPrompts.push(...fresh);
        log(`Moved ${fresh.length} old prompt set(s) to legacy archive`);
    }
    settings.customSystemPrompt = '';

    for (const slot of Object.keys(settings.customPrompts)) {
        if (!PROMPT_SLOTS[slot]) delete settings.customPrompts[slot];
    }
}

export function saveSettings() {
    saveSettingsDebounced();
}

export function updateSetting(key, value) {
    if (state.settings) {
        state.settings[key] = value;
        saveSettings();
    }
}

export function resetSettingValues() {
    for (const key of RESETTABLE_SETTING_KEYS) {
        state.settings[key] = structuredClone(defaultSettings[key]);
    }
    fillDefaults(state.settings);
    saveSettings();
}

export function resetAllSettings() {
    for (const key of Object.keys(state.settings)) delete state.settings[key];
    Object.assign(state.settings, structuredClone(defaultSettings));
    fillDefaults(state.settings);
    saveSettings();
}

export function exportSettingsSnapshot() {
    const copy = structuredClone(state.settings);
    delete copy.history;
    return copy;
}

export function importSettingsSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new Error('백업 파일에 설정이 없습니다.');
    }
    const keepHistory = state.settings.history;
    for (const key of Object.keys(state.settings)) delete state.settings[key];
    for (const key of Object.keys(defaultSettings)) {
        state.settings[key] = snapshot[key] !== undefined ? structuredClone(snapshot[key]) : structuredClone(defaultSettings[key]);
    }
    state.settings.history = keepHistory || [];
    if (snapshot.density === undefined && snapshot.concise === true) state.settings.density = 'concise';
    fillDefaults(state.settings);
    migrateSettings(state.settings);
    saveSettings();
}

// 실제로 사용할 프롬프트 (수정본이 있으면 수정본, 없으면 기본값)
// requireText 항목은 비어 있으면 기본값, 그 외는 비어 있으면 '' (해당 블록 생략)
export function getPrompt(slot) {
    const def = PROMPT_SLOTS[slot];
    if (!def) return '';
    const custom = state.settings?.customPrompts;
    if (custom && Object.hasOwn(custom, slot)) {
        const text = String(custom[slot] ?? '');
        if (!def.requireText || text.trim()) return text.trim();
    }
    return def.default;
}

export function isPromptCustomized(slot) {
    return !!state.settings?.customPrompts && Object.hasOwn(state.settings.customPrompts, slot);
}

export function setCustomPrompt(slot, text) {
    const def = PROMPT_SLOTS[slot];
    if (!def || !state.settings) return;
    state.settings.customPrompts ||= {};
    if (text.trim() === def.default.trim()) {
        delete state.settings.customPrompts[slot];
    } else {
        state.settings.customPrompts[slot] = text;
    }
    saveSettings();
}

export function resetPrompt(slot) {
    if (!state.settings?.customPrompts) return;
    delete state.settings.customPrompts[slot];
    saveSettings();
}
