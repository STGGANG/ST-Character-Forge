import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName, defaultSettings, CARD_FIELDS, LANGUAGES, RESETTABLE_SETTING_KEYS, DENSITY_LEVELS, SETTING_FIELDS, SUPPORTER_FACES, FONT_SCALES, GUIDELINE_PLACEMENTS } from './constants.js';
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
    if (!Number.isInteger(settings.hammerTaps) || settings.hammerTaps < 0) settings.hammerTaps = 0;
    settings.matureContent = settings.matureContent === true;
    settings.guidelinesPlacement = normalizeGuidelinesPlacement(settings.guidelinesPlacement);
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

    // 서포터 대화 규칙은 네 칸으로 나뉨 — 직접 고친 한 덩어리 글은 자동으로 나눌 수 없어 보관함으로 (기본값으로 시작)
    const oldRules = [];
    if (Object.hasOwn(settings.customPrompts, 'supporterRules')) {
        oldRules.push({ name: '적용 중이던 수정본', prompts: { supporterRules: String(settings.customPrompts.supporterRules ?? '') } });
        delete settings.customPrompts.supporterRules;
    }
    for (const preset of settings.promptPresets) {
        if (preset.prompts && Object.hasOwn(preset.prompts, 'supporterRules')) {
            oldRules.push({ name: `프리셋: ${preset.name}`, prompts: { supporterRules: String(preset.prompts.supporterRules ?? '') } });
            delete preset.prompts.supporterRules;
        }
    }
    const knownRules = new Set(settings.legacyPrompts.map(set => JSON.stringify(set.prompts)));
    const freshRules = oldRules.filter(set => !knownRules.has(JSON.stringify(set.prompts)));
    if (freshRules.length) settings.legacyPrompts.push(...freshRules);

    // [공통] 칸 수정본은 탭마다 따로 — 예전 한 칸짜리 수정본은 그 칸을 쓰는 탭마다 복사
    splitScopedPrompts(settings.customPrompts);
    for (const preset of settings.promptPresets) {
        if (preset.prompts) splitScopedPrompts(preset.prompts);
        if (preset.scope !== undefined && !PROMPT_SCOPES.includes(preset.scope)) delete preset.scope;
    }

    for (const key of Object.keys(settings.customPrompts)) {
        if (!isKnownPromptKey(key)) delete settings.customPrompts[key];
    }

    const labels = settings.promptLabels && typeof settings.promptLabels === 'object' ? settings.promptLabels : {};
    settings.promptLabels = Object.fromEntries(Object.entries(labels)
        .filter(([slot, name]) => PROMPT_SLOTS[slot] && typeof name === 'string' && name.trim())
        .map(([slot, name]) => [slot, name.trim().slice(0, PROMPT_LABEL_MAX)]));
}

function splitScopedPrompts(prompts) {
    for (const slot of Object.keys(PROMPT_SLOTS)) {
        if (!isScopedSlot(slot) || !Object.hasOwn(prompts, slot)) continue;
        for (const scope of promptScopesOf(slot)) {
            const key = `${slot}@${scope}`;
            if (!Object.hasOwn(prompts, key)) prompts[key] = prompts[slot];
        }
        delete prompts[slot];
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
export function normalizeGuidelinesPlacement(value) {
    const source = value && typeof value === 'object' ? value : {};
    const pick = key => (Object.hasOwn(GUIDELINE_PLACEMENTS, source[key]) ? source[key] : 'user');
    return { guidelines: pick('guidelines'), botGuidelines: pick('botGuidelines') };
}

export function getGuidelinesPlacement(slot) {
    return normalizeGuidelinesPlacement(state.settings?.guidelinesPlacement)[slot] || 'user';
}

// ===== 프롬프트 칸 =====
// 탭(묶음): persona / bot / supporter. 여러 탭에서 쓰는 [공통] 칸은 기본값만 같고 수정본은 탭마다 따로 ("칸@탭" 키)
export const PROMPT_SCOPES = ['persona', 'bot', 'supporter'];
export const PROMPT_LABEL_MAX = 40;

export function promptScopesOf(slot) {
    return PROMPT_SLOTS[slot]?.modes || ['persona', 'bot'];
}

export function isScopedSlot(slot) {
    return promptScopesOf(slot).length > 1;
}

// customPrompts에 저장되는 키 — [공통] 칸은 "칸@탭" (탭을 안 주거나 맞지 않으면 첫 탭)
export function promptKey(slot, scope) {
    if (!isScopedSlot(slot)) return slot;
    const scopes = promptScopesOf(slot);
    return `${slot}@${scopes.includes(scope) ? scope : scopes[0]}`;
}

export function isKnownPromptKey(key) {
    const [slot, scope, extra] = String(key).split('@');
    if (!PROMPT_SLOTS[slot] || extra !== undefined) return false;
    return scope === undefined ? !isScopedSlot(slot) : isScopedSlot(slot) && promptScopesOf(slot).includes(scope);
}

// 그 탭에 속한 저장 키 전부 (그 탭 전용 칸 + 그 탭의 [공통] 칸)
export function promptKeysOfScope(scope) {
    return Object.keys(PROMPT_SLOTS).filter(slot => promptScopesOf(slot).includes(scope)).map(slot => promptKey(slot, scope));
}

// 비우면 '' (블록 생략) — 비울 수 없는 칸(requireText: 남매 이름)만 기본값으로
export function getPrompt(slot, scope) {
    const def = PROMPT_SLOTS[slot];
    if (!def) return '';
    const custom = state.settings?.customPrompts;
    const key = promptKey(slot, scope);
    if (custom && Object.hasOwn(custom, key)) {
        const text = String(custom[key] ?? '');
        if (!def.requireText || text.trim()) return text.trim();
    }
    return def.default;
}

export function isPromptCustomized(slot, scope) {
    return !!state.settings?.customPrompts && Object.hasOwn(state.settings.customPrompts, promptKey(slot, scope));
}

export function setCustomPrompt(slot, text, scope) {
    const def = PROMPT_SLOTS[slot];
    if (!def || !state.settings) return;
    state.settings.customPrompts ||= {};
    const key = promptKey(slot, scope);
    if (text.trim() === def.default.trim()) {
        delete state.settings.customPrompts[key];
    } else {
        state.settings.customPrompts[key] = text;
    }
    saveSettings();
}

export function resetPrompt(slot, scope) {
    if (!state.settings?.customPrompts) return;
    delete state.settings.customPrompts[promptKey(slot, scope)];
    saveSettings();
}

// 표시 이름 — 직접 붙인 이름이 있으면 "[분류] 이름", 없으면 기본 이름
export function getPromptLabel(slot) {
    const name = state.settings?.promptLabels?.[slot];
    return typeof name === 'string' && name.trim() ? name.trim() : '';
}

export function promptDisplayLabel(slot) {
    const def = PROMPT_SLOTS[slot];
    if (!def) return '';
    const name = getPromptLabel(slot);
    if (!name) return def.label;
    const prefix = def.label.match(/^\[[^\]]+\]\s*/)?.[0] || '';
    return `${prefix}${name}`;
}

export function setPromptLabel(slot, name) {
    if (!PROMPT_SLOTS[slot] || !state.settings) return;
    state.settings.promptLabels ||= {};
    const clean = String(name || '').trim().slice(0, PROMPT_LABEL_MAX);
    const defaultName = PROMPT_SLOTS[slot].label.replace(/^\[[^\]]+\]\s*/, '');
    if (!clean || clean === defaultName) delete state.settings.promptLabels[slot];
    else state.settings.promptLabels[slot] = clean;
    saveSettings();
}
