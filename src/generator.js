import { getContext } from "../../../../extensions.js";
import {
    PROFILE_FIELDS, TEMPLATE_PRESETS, LANGUAGES, CARD_FIELDS, BOT_DIRECTIONS, GREETING_LENGTHS, DENSITY_LEVELS, SETTING_FIELDS,
    MANUAL_PERSONA_ID, SUPPORTER_FACES,
} from './constants.js';
import {
    USER_GUIDELINES_INTRO, TRANSLATOR_ROLE, GREETING_ROLE, WORLD_GREETING_ROLE, SUPPORTER_FACE_RULE,
    DEFAULT_SUPPORTER_NAME_FEMALE, DEFAULT_SUPPORTER_NAME_MALE,
} from './prompt-defaults.js';
import {
    state, log, getSettings,
    beginOperation, isCurrentOperation, endOperation, cancelledError,
} from './state.js';
import { getPrompt } from './storage.js';
import { callGenerationAPI } from './api.js';
import { getCharacterKey, getSelectedEntries, getSelectedBookNames, MANUAL_CHARACTER_KEY, NO_CHARACTER_KEY } from './worldinfo.js';

function cleanExtensionTags(text) {
    if (!text) return '';
    return String(text)
        .replace(/<pic\s[^>]*>/gi, '')
        .replace(/<\/pic>/gi, '')
        .replace(/<image_generation>[\s\S]*?<\/image_generation>/gi, '')
        .replace(/<\/?img[^>]*>/gi, '')
        .replace(/<status[^>]*>[\s\S]*?<\/status>/gi, '')
        .replace(/<choice[^>]*>[\s\S]*?<\/choice>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// 모델이 결과를 감쌀 때 흉내 내는 태그 (결과 앞뒤에 있으면 제거)
const WRAPPER_TAG_LINE = /^<\/?(?:output_format|task|current_profile|current_message|character_profile|source_text|sheet_template|reference|profile|persona_profile|persona|translation|greeting|opening_message|first_message|answer|response|result|output)>\s*$/i;

export function cleanGeneratedText(text, { scene = false } = {}) {
    if (!text) return '';
    let cleaned = String(text)
        // 추론 내용이 본문에 섞여 온 경우
        .replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
        // AutoPic 등 다른 확장 태그를 모델이 재생산한 경우
        .replace(/<pic\s[^>]*>/gi, '')
        .replace(/<\/pic>/gi, '')
        .replace(/<image_generation>[\s\S]*?<\/image_generation>/gi, '')
        .replace(/<\/?img[^>]*>/gi, '')
        .replace(/<status[^>]*>[\s\S]*?<\/status>/gi, '')
        .replace(/<choice[^>]*>[\s\S]*?<\/choice>/gi, '')
        // ``` 코드블록으로 감싼 경우
        .replace(/^```[a-z]*\n?/gm, '')
        .replace(/^```\s*$/gm, '');

    const lines = cleaned.trim().split('\n');
    while (lines.length && WRAPPER_TAG_LINE.test(lines[0].trim())) lines.shift();
    while (lines.length && WRAPPER_TAG_LINE.test(lines[lines.length - 1].trim())) lines.pop();
    cleaned = dropStrayHeaders(lines.join('\n'));

    return dropChatter(cleaned.replace(/\n{3,}/g, '\n\n').trim(), { scene });
}

// ===== 사족·거절 방어 =====
// "이것만 출력" 지시에도 모델이 앞뒤에 붙이는 한두 줄짜리 말 (본문·대사와 헷갈리지 않게 작업 이야기를 할 때만)
const LEAD_CHATTER = [
    /^(?:(?:sure|certainly|of course|okay|ok|alright|absolutely)[,.!]?\s*)?(?:here(?:['’]s| is| are)|below (?:is|are)|i['’]ve (?:written|created|revised|translated|rewritten|updated)|this is)\b.*\b(?:profile|persona|character|greeting|opening|message|setting|world|translation|section|version|sheet)\b/i,
    /(?:다음은|아래는|요청하신|작성한|작성했|완성한|완성했|번역한|번역했|수정한|수정했|다시 쓴).*(?:프로필|페르소나|캐릭터|그리팅|첫 메시지|세계관|설정|번역|섹션|시트)/,
];
// 끝 인사는 작업 이야기(수정·프로필 등)를 할 때만 — "원하시면 말씀해 주세요"가 대사일 수 있어서
const TRAIL_OFFER = /(?:let me know|feel free|i hope (?:this|you)|hope this|if you(?:['’]d| would) like|would you like|want me to|i can (?:also |further )?(?:adjust|revise|change|expand|tweak)|필요하시면|원하시면|말씀해 ?주세요|수정해 ?드릴|바꿔 ?드릴|도움이 되|더 필요한|궁금한 점)/i;
const TRAIL_TOPIC = /(?:profile|persona|character|section|changes?|adjust|revise|tweak|edit|modif|greeting|message|translation|프로필|페르소나|캐릭터|섹션|수정|변경|바꿔|조정|그리팅|메시지|번역)/i;
// 면책성 메모 ("Note: this is fiction…")
const TRAIL_DISCLAIMER = /^[(*_\[]*\s*(?:note|disclaimer|ooc|참고|주의|면책)\s*[:：].*(?:fiction|fictional|this (?:profile|greeting|content|message)|adult|픽션|허구|이 (?:프로필|그리팅|내용|메시지)|성인)/i;
const SEPARATOR_LINE = /^(?:-{3,}|\*{3,}|_{3,})$/;

// 짧고(두 줄·250자 이하), 헤더·목록·인용(대사)으로 시작하지 않는 문단만 사족 후보
function isChatterShape(paragraph) {
    const text = paragraph.trim();
    const lines = text.split('\n');
    return lines.length <= 2 && text.length <= 250 && !isHeaderLine(lines[0]) && !/^[-*•"“'‘「『]/.test(text);
}

function isLeadChatter(paragraph, scene) {
    const text = paragraph.trim();
    if (!isChatterShape(text) || !LEAD_CHATTER.some(pattern => pattern.test(text))) return false;
    return !scene || /[:：]$/.test(text); // 그리팅은 "…입니다:"처럼 콜론으로 끝나는 머리말만
}

function isTrailChatter(paragraph, scene) {
    const text = paragraph.trim();
    if (!isChatterShape(text)) return false;
    if (TRAIL_DISCLAIMER.test(text)) return true;
    return !scene && TRAIL_OFFER.test(text) && TRAIL_TOPIC.test(text);
}

// 맨 앞·맨 뒤 문단이 사족이면 떼어 냄 (구분선도 함께) — 본문이 남을 때만
// scene: 그리팅 (대사가 많아 더 조심스럽게)
function dropChatter(text, { scene = false } = {}) {
    const paragraphs = text.split(/\n{2,}/);
    while (paragraphs.length > 1 && isLeadChatter(paragraphs[0], scene)) {
        paragraphs.shift();
        while (paragraphs.length > 1 && SEPARATOR_LINE.test(paragraphs[0].trim())) paragraphs.shift();
    }
    while (paragraphs.length > 1 && isTrailChatter(paragraphs.at(-1), scene)) {
        paragraphs.pop();
        while (paragraphs.length > 1 && SEPARATOR_LINE.test(paragraphs.at(-1).trim())) paragraphs.pop();
    }
    return paragraphs.join('\n\n').trim();
}

// 거절문 — 짧고, 사과·거절로 시작하며, 요청·정책·AI 이야기를 하는 답
// (그리팅은 대사 속 "죄송해요, 요청하신…"과 헷갈리지 않게 정책·AI 이야기일 때만)
const REFUSAL_START = /^(?:i['’]?m sorry|i am sorry|sorry|i apologi[sz]e|i can['’]?t|i cannot|i['’]?m (?:not able|unable)|i am (?:not able|unable)|i won['’]?t|i will not|as an ai|unfortunately|죄송|미안하지만|유감스럽|안타깝지만|저는 (?:ai|인공지능|어시스턴트)|해당 요청|이 요청|요청하신 (?:내용|콘텐츠|작업))/i;
const REFUSAL_TOPIC = /\b(?:request|content|polic(?:y|ies)|guidelines?|appropriate|explicit|ai|assistant|comply|assist|help with)\b|요청|콘텐츠|정책|가이드라인|부적절|노골적|어시스턴트|인공지능|도와드리|제공(?:할|해 드릴) 수 없|작성(?:할|해 드릴) 수 없|할 수 없/i;
const REFUSAL_TOPIC_STRICT = /\b(?:polic(?:y|ies)|guidelines?|as an ai|an ai|language model|assistant|content policy)\b|정책|가이드라인|어시스턴트|인공지능|언어 모델/i;

export function looksLikeRefusal(text, { scene = false } = {}) {
    const t = String(text || '').trim();
    if (!t || t.length > 700 || !REFUSAL_START.test(t)) return false;
    if (scene) return REFUSAL_TOPIC_STRICT.test(t);
    // 프로필 쪽은 헤더가 하나라도 있으면 결과로 봄
    return !/^\s*#{1,6}[ \t]+\S/m.test(t) && REFUSAL_TOPIC.test(t);
}

// 기본~Full·Choice 결과의 "# 이름 — Character Profile" 같은 제목 줄에서 꼬리표를 떼어 이름만 남김
// "# Character Profile"처럼 이름 없이 꼬리표만 있으면 프로필에서 찾은 이름으로 바꿈 (못 찾으면 줄을 지움)
const PROFILE_WORDS = String.raw`(?:character[ \t]+(?:profile|sheet|bio)|profile|캐릭터[ \t]*(?:프로필|시트)|인물[ \t]*프로필|프로필)`;
const TITLE_SUFFIX = new RegExp(String.raw`^(#[ \t]+.*?\S)[ \t]*[—–:|·-][ \t]*${PROFILE_WORDS}[ \t]*$`, 'i');
const TITLE_ONLY = new RegExp(String.raw`^#[ \t]+${PROFILE_WORDS}[ \t]*$`, 'i');

// 자유 입력·기존 캐릭터 참고·직접 추가한 결과는 제목 줄을 양식(원본) 그대로 둠
export function keepsOwnTitle(gen) {
    return ['custom', 'mirror', 'manual'].includes(gen?.templateId);
}

export function tidyTitleLines(text) {
    const name = guessProfileName(text);
    return String(text || '').split('\n')
        .map(line => (TITLE_ONLY.test(line.trim()) ? (name ? `# ${name}` : null) : line.replace(TITLE_SUFFIX, '$1')))
        .filter(line => line !== null)
        .join('\n')
        .replace(/^\n+/, '');
}

function dropStrayHeaders(text) {
    const lines = text.split('\n');
    const isH2 = line => /^##[ \t]+\S/.test(line);
    const seen = new Set();
    return lines.filter((line, index) => {
        if (!isH2(line)) return true;
        const header = line.trim();
        const next = lines.slice(index + 1).find(l => l.trim());
        if (seen.has(header) && next && isH2(next)) return false;
        seen.add(header);
        return true;
    }).join('\n');
}

// 참조 텍스트의 매크로 정리
// - {{user}}: 그대로 유지 (만들고 있는 페르소나 — 현재 페르소나로 치환하지 않음)
// - {{char}}: 참고한 캐릭터 이름으로 치환 (지금 열린 채팅의 캐릭터와 다를 수 있으므로)
// - 구형 표기 <USER> / <BOT> / <CHAR> 도 같은 규칙으로 정리
function normalizeMacros(text, charName) {
    if (!text) return '';
    return String(text)
        .replace(/\{\{user\}\}|<USER>/gi, '{{user}}')
        .replace(/\{\{char\}\}|<BOT>|<CHAR>/gi, charName || 'the target character');
}

function escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrap(tag, content, attrs = '') {
    return `<${tag}${attrs}>\n${String(content).trim()}\n</${tag}>`;
}

function languageInfo(code) {
    return LANGUAGES[code] || LANGUAGES.en;
}

export function makeManualCharacter(manual) {
    return {
        name: String(manual?.name || '').trim(),
        avatar: '',
        isManual: true,
        data: { description: String(manual?.description || '') },
    };
}

function getCharName(charData) {
    return String(charData?.name || charData?.data?.name || '').trim();
}

export function getTargetDisplayName(charData) {
    return getCharName(charData) || (charData?.isManual ? '직접 입력한 캐릭터' : 'Unknown');
}

// 캐릭터 전체 데이터 확보
// 실리태번은 캐릭터 목록을 가볍게(설명 등 본문 없이) 불러두고, 채팅을 열 때 나머지를 읽음.
// 그대로 쓰면 설명이 빈 채로 전송되므로 필요하면 전체 데이터를 먼저 불러옴
export async function ensureFullCharacter(charData) {
    if (!charData?.shallow || charData.isManual) return charData;
    const context = getContext();
    const key = getCharacterKey(charData);
    const index = (context.characters || []).findIndex(c => getCharacterKey(c) === key);
    if (index < 0 || typeof context.unshallowCharacter !== 'function') return charData;

    await context.unshallowCharacter(index);
    const full = getContext().characters?.[index] || charData;
    if (state.selectedCharKey === key) state.selectedCharData = full;
    return full;
}

function resolveGenerationCharacter() {
    const gen = state.currentGeneration;
    if ((gen?.mode === 'bot' || gen?.noTarget) && !gen.charAvatar && !gen.manualCharacter) {
        return { charData: null, isSelected: state.selectedCharKey === NO_CHARACTER_KEY };
    }
    if (gen?.manualCharacter) {
        return {
            charData: makeManualCharacter(gen.manualCharacter),
            isSelected: state.selectedCharKey === MANUAL_CHARACTER_KEY,
        };
    }
    const avatar = gen?.charAvatar;
    if (avatar) {
        if (avatar === state.selectedCharKey && state.selectedCharData) {
            return { charData: state.selectedCharData, isSelected: true };
        }
        const found = getContext().characters?.find(c => getCharacterKey(c) === avatar);
        if (found) return { charData: found, isSelected: false };
    }
    return { charData: state.selectedCharData, isSelected: true };
}

function getCardFieldText(charData, key) {
    const data = charData?.data || {};
    switch (key) {
        case 'description': return data.description || charData?.description || '';
        case 'personality': return data.personality || charData?.personality || '';
        case 'scenario': return data.scenario || charData?.scenario || '';
        case 'first_mes': return data.first_mes || charData?.first_mes || '';
        case 'mes_example': return data.mes_example || charData?.mes_example || '';
        case 'alternate_greetings':
            return (Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [])
                .map(text => String(text || '').trim())
                .filter(Boolean);
        case 'depth_prompt': return data.extensions?.depth_prompt?.prompt || '';
        case 'creator_notes': return data.creator_notes || charData?.creatorcomment || '';
        case 'system_prompt': return data.system_prompt || '';
        case 'post_history_instructions': return data.post_history_instructions || '';
        default: return '';
    }
}

export function isCardFieldEnabled(key, charData = null) {
    const field = CARD_FIELDS[key];
    if (!field) return false;
    if (field.always) return true;
    if (charData?.isManual) return false;
    const value = getSettings()?.cardFields?.[key];
    return typeof value === 'boolean' ? value : !!field.defaultOn;
}

export function getCardFieldTexts(charData) {
    return Object.fromEntries(Object.keys(CARD_FIELDS).map(key => {
        const value = getCardFieldText(charData, key);
        return [key, Array.isArray(value) ? value.join('\n\n') : String(value).trim()];
    }));
}

// 참고 자료 순서: 월드인포(배경) → 캐릭터
function buildReference(charData, { includeWorldInfo = true } = {}) {
    const name = getCharName(charData);
    const parts = [];
    const worldInfo = includeWorldInfo ? buildWorldInfoBlock(name || 'the target character') : '';
    if (worldInfo) parts.push(worldInfo);
    if (charData) parts.push(buildCharacterBlock(charData));
    return parts.length ? wrap('reference', parts.join('\n')) : '';
}

function buildCharacterBlock(charData) {
    const name = getCharName(charData);
    const charLabel = name || 'the target character';
    const macros = text => normalizeMacros(cleanExtensionTags(text), charLabel);

    const fields = [];
    for (const [key, field] of Object.entries(CARD_FIELDS)) {
        if (!isCardFieldEnabled(key, charData)) continue;
        const value = getCardFieldText(charData, key);
        if (Array.isArray(value)) {
            if (value.length) {
                fields.push(wrap(field.tag, value.map((text, idx) => wrap('greeting', macros(text), ` n="${idx + 1}"`)).join('\n')));
            }
        } else if (String(value).trim()) {
            fields.push(wrap(field.tag, macros(value)));
        }
    }

    return wrap('character', fields.join('\n'), name ? ` name="${escapeAttr(name)}"` : '');
}

function buildWorldInfoBlock(charLabel) {
    if (!getSettings().includeWorldInfo) return '';
    const entries = getSelectedEntries(state.wiBooks);
    if (!entries.length) return '';
    return wrap('world_info', entries
        .map(entry => wrap('entry', normalizeMacros(cleanExtensionTags(entry.content), charLabel), ` name="${escapeAttr(entry.name)}"`))
        .join('\n'));
}

const NEW_CHARACTER_LABEL = 'the new character';

export function isBotMode() {
    return getSettings()?.forgeMode === 'bot';
}

function modeOf(gen) {
    return gen?.mode === 'bot' ? 'bot' : 'persona';
}

export function listPersonas() {
    const powerUser = getContext().powerUserSettings || {};
    const names = powerUser.personas || {};
    const descriptions = powerUser.persona_descriptions || {};
    return Object.entries(names)
        .map(([id, name]) => ({
            id,
            name: String(name || id),
            description: String(descriptions[id]?.description || ''),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function findPersona(personaId) {
    if (!personaId) return null;
    if (personaId === MANUAL_PERSONA_ID) {
        const manual = getSettings().manualPersona || {};
        return { id: MANUAL_PERSONA_ID, name: String(manual.name || '').trim(), description: String(manual.description || '') };
    }
    return listPersonas().find(persona => persona.id === personaId) || null;
}

// 모드별로 고른 내 페르소나 (봇: {{user}}로 등장할 페르소나 / 페르소나: 바탕으로 삼을 기존 페르소나)
export function selectedPersonaId(bot = isBotMode()) {
    return String(getSettings()[bot ? 'botPersona' : 'personaBase'] || '');
}

// 페르소나 모드 — 바탕으로 삼을 내 기존 페르소나
function basePersonaBlock(personaId, charLabel) {
    const persona = findPersona(personaId);
    const text = persona?.description.trim();
    if (!text) return '';
    return wrap('base_persona', normalizeMacros(cleanExtensionTags(text), charLabel), persona.name ? ` name="${escapeAttr(persona.name)}"` : '');
}

function buildBotSourceBlocks(charData, personaId, { includeWorldInfo = true } = {}) {
    const refChar = charData && !charData.isManual ? charData : null;
    const refName = getCharName(refChar);
    // 참고 자료 순서: 월드인포(배경) → 내 페르소나 → 기존 캐릭터
    const reference = [];
    const worldInfo = includeWorldInfo ? buildWorldInfoBlock(refName || NEW_CHARACTER_LABEL) : '';
    if (worldInfo) reference.push(worldInfo);

    const persona = findPersona(personaId);
    if (persona?.description.trim()) {
        reference.push(wrap('user_persona',
            normalizeMacros(cleanExtensionTags(persona.description), NEW_CHARACTER_LABEL),
            persona.name ? ` name="${escapeAttr(persona.name)}"` : ''));
    }
    if (refChar) reference.push(buildCharacterBlock(refChar));

    const blocks = [];
    if (reference.length) blocks.push(wrap('reference', reference.join('\n')));

    const notes = charData?.isManual ? String(charData.data?.description || '').trim() : '';
    if (notes) {
        const title = getCharName(charData);
        blocks.push(wrap('user_notes', normalizeMacros(notes, NEW_CHARACTER_LABEL), title ? ` title="${escapeAttr(title)}"` : ''));
    }
    return blocks;
}

// 봇 모드에서 내 페르소나를 참고할 때 — 결과에 페르소나 이름 대신 {{user}}를 쓰게 하는 문장
// (규칙만으로는 페르소나 이름을 그대로 쓰는 모델이 있어, 실제 이름을 짚어서 알려줌)
function personaNameNote(personaId) {
    const persona = findPersona(personaId);
    if (!persona?.description.trim() || !persona.name) return '';
    return `{{user}}'s persona is in <user_persona>. When you refer to {{user}}, write {{user}}; don't call them by the persona's name ("${persona.name}") or a short form or nickname of it, since the name is filled in when the chat runs. Other words and names are unaffected.`;
}

function sourceBlocksFor(gen, charData, includeWorldInfo) {
    if (modeOf(gen) === 'bot') return buildBotSourceBlocks(charData, gen.personaId, { includeWorldInfo });
    return [buildReference(charData, { includeWorldInfo })].filter(Boolean);
}

// "# Setting" 제목부터 다음 "# " 제목 전까지 (세계관 블록)
const SETTING_BLOCK = /^#[ \t]+Setting[ \t]*\n[\s\S]*?(?=^#[ \t]|(?![\s\S]))/im;

export function guessProfileName(text) {
    const source = String(text || '').replace(SETTING_BLOCK, '');
    const patterns = [
        /^[ \t]*[-*•]?[ \t]*(?:\*\*)?(?:full name|name|이름|성명|本名|名前|氏名|姓名|名字)(?:\*\*)?[ \t]*[:：][ \t]*(.+)$/im,
        /^[ \t]*[【\[][ \t]*(?:이름|name|名前|姓名)[ \t]*[】\]][ \t]*[:：]?[ \t]*(.+)$/im,
    ];
    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (!match) continue;
        const name = match[1]
            .replace(/\*\*/g, '')
            .replace(/\s*[(（][^)）]*[)）]/g, ' ')
            .split(/[,，、/|;；]/)[0]
            .replace(/\s*[(（].*$/, '')
            .replace(/["“”「」『』]/g, '')
            .trim();
        if (name && name.length <= 40) return name;
    }
    return '';
}

function refreshBotName(gen) {
    if (modeOf(gen) !== 'bot') return;
    gen.charName = gen.worldOnly
        ? guessWorldName(gen.fullText) || worldFallbackName(gen.fullText)
        : guessProfileName(gen.fullText) || gen.charName || '새 캐릭터';
}

// 세계 이름이 없을 때 — "세계관 · 장르 첫 단어" (예: 세계관 · 어반 판타지)
function worldFallbackName(text) {
    const genre = String(text || '').match(/^[ \t]*[-*•]?[ \t]*(?:\*\*)?(?:genre|장르|ジャンル|类型|類型)(?:\*\*)?[ \t]*[:：][ \t]*(.+)$/im);
    const first = genre ? genre[1].replace(/\*\*/g, '').split(/[,，、/|;；]/)[0].trim() : '';
    return first && first.length <= 20 ? `세계관 · ${first}` : '세계관';
}

// 세계관만 만든 결과의 이름 — "세계 이름:"·"명칭:" 같은 줄 (없으면 빈 값)
export function guessWorldName(text) {
    const match = String(text || '').match(/^[ \t]*[-*•]?[ \t]*(?:\*\*)?(?:world name|setting name|name|세계 ?이름|세계명|명칭|이름|국가명|名前|名称|名字)(?:\*\*)?[ \t]*[:：][ \t]*(.+)$/im);
    if (!match) return '';
    const name = match[1].replace(/\*\*/g, '').replace(/\s*[(（][^)）]*[)）]/g, ' ').split(/[,，、/|;；]/)[0].replace(/["“”「」『』]/g, '').trim();
    return name.length <= 40 ? name : '';
}

// NSFW 지침 — 설정에서 켰을 때만 (번역 제외 모든 생성·서포터 대화)
// 끝에 가까울수록 잘 따르므로 사용자 메시지의 작업 지시(<task>, 컨셉·수정 지시 포함) 바로 뒤, 출력 형식 앞에
// (서포터 대화는 설정 자료(<material>) 뒤 — 시스템 프롬프트 맨 끝)
function matureContentBlock() {
    if (!getSettings().matureContent) return '';
    const text = getPrompt('matureContent');
    return text ? wrap('smut_guidance', text) : '';
}

// 작성 원칙 뒤에 붙는 공통 문체 규칙 (비어 있으면 없음)
function pushWritingStyle(parts) {
    const style = getPrompt('writingStyle');
    if (style) parts.push(wrap('writing_style', style));
}

function buildCoreSystem(options = {}) {
    const parts = [getPrompt('role')];
    const principles = getPrompt('principles');
    if (principles) parts.push(wrap('principles', principles));
    pushWritingStyle(parts);
    parts.push(wrap('source_rules', getPrompt('sourceRules')));
    if (getSettings().spoilerProtection) {
        const spoiler = getPrompt('spoiler');
        if (spoiler) parts.push(wrap('spoiler_policy', spoiler));
    }
    const density = densityBlock(options);
    if (density) parts.push(density);
    const guidelines = getPrompt('guidelines');
    if (guidelines) parts.push(wrap('user_guidelines', `${USER_GUIDELINES_INTRO}\n${guidelines}`));
    return parts.join('\n\n');
}

// 기존 캐릭터 참고(Mirror) 템플릿이 따를 프로필이 어디 있는지 (프롬프트 문구용)
// 페르소나 모드: 참고한 캐릭터 설명 / 봇 모드: 참고한 캐릭터 설명, 없으면 직접 입력 메모
function describeMirrorSource(charData, isBot) {
    if (isBot && charData?.isManual) {
        if (String(charData.data?.description || '').trim()) return 'the profile in <user_notes>';
    } else if (charData && String(getCardFieldText(charData, 'description') || '').trim()) {
        const name = getCharName(charData);
        return `the <description> of ${name ? `<character name="${escapeAttr(name)}">` : '<character>'} in <reference>`;
    }
    // 카드 설명이 비어 있는 봇 (다인봇처럼 인물 프로필을 월드인포에 둔 경우) → 고른 월드인포 속 인물 항목
    if (getSettings().includeWorldInfo && getSelectedEntries(state.wiBooks).length) {
        return 'the character profiles among the <world_info> entries in <reference> (the entries that describe a single person; if there are several, the layout they share)';
    }
    return '';
}

function buildBotCoreSystem(options = {}) {
    const parts = [getPrompt('botRole')];
    const principles = getPrompt('botPrinciples');
    if (principles) parts.push(wrap('principles', principles));
    pushWritingStyle(parts);
    parts.push(wrap('source_rules', getPrompt('botSourceRules')));
    const density = densityBlock(options);
    if (density) parts.push(density);
    const guidelines = getPrompt('botGuidelines');
    if (guidelines) parts.push(wrap('user_guidelines', `${USER_GUIDELINES_INTRO}\n${guidelines}`));
    return parts.join('\n\n');
}

// 분량 블록 — 틀이 정해진 결과(기존 캐릭터 참고·자유 입력·직접 추가)는 틀을 우선하고,
// 세계관만일 때는 인물 기준 문장을 세계로 읽게 한 줄씩 덧붙임
const DENSITY_LAYOUT_NOTE = 'The layout in <output_format> comes first: keep its sections and its way of writing (lists or prose), and apply the above only to how much you write in each part.';
const DENSITY_WORLD_NOTE = 'This request is a setting, not a character profile: read "the character" above as the world, and give the space to its rules, places, factions, and what play will need.';

function densityBlock({ worldOnly = false, fixedLayout = false } = {}) {
    const slot = DENSITY_LEVELS[getSettings().density]?.slot;
    const density = slot ? getPrompt(slot) : '';
    if (!density) return '';
    const notes = [fixedLayout && DENSITY_LAYOUT_NOTE, worldOnly && DENSITY_WORLD_NOTE].filter(Boolean);
    return wrap('density', [density, ...notes].join('\n'));
}

// 봇 모드에서 캐릭터 없이 세계관만 만들 때 — 인물용 역할·원칙·자료 규칙 대신 세계관용
function buildWorldCoreSystem(options = {}) {
    const parts = [getPrompt('worldRole')];
    const principles = getPrompt('worldPrinciples');
    if (principles) parts.push(wrap('principles', principles));
    pushWritingStyle(parts);
    parts.push(wrap('source_rules', getPrompt('worldSourceRules')));
    const density = densityBlock(options);
    if (density) parts.push(density);
    const guidelines = getPrompt('botGuidelines');
    if (guidelines) parts.push(wrap('user_guidelines', `${USER_GUIDELINES_INTRO}\n${guidelines}`));
    return parts.join('\n\n');
}

// options: { worldOnly, fixedLayout } — 분량 블록에 덧붙일 줄을 정함
function coreSystemFor(mode, options = {}) {
    if (mode === 'bot') return options.worldOnly ? buildWorldCoreSystem(options) : buildBotCoreSystem(options);
    return buildCoreSystem(options);
}

// 섹션 재생성·전체 수정 — 결과의 틀과 세계관만 여부
function coreSystemForResult(gen) {
    return coreSystemFor(modeOf(gen), { worldOnly: !!gen.worldOnly, fixedLayout: !!gen.isCustomSheet || keepsOwnTitle(gen) });
}

// 출력 언어는 문장만 바꿈 — 배경 문화를 출력(지시) 언어 쪽으로 끌어오지 않게 (언어 이름은 짚지 않음: 그 나라 인물을 피하게 될 수 있어서),
// 그리고 다른 언어 단어를 섞어 쓰지 않게 (예: 한국어 문장 속 "blunt한")
function languageNotes(promptName) {
    return `Characters' nationality and background have nothing to do with the output language or the language of these instructions. Don't tie them to any particular country by default: imagine them freely to fit the setting, as a local, an immigrant, a traveler, someone from another world, and so on. If the reference or the user specifies them, follow that. Foods, institutions, customs, and culture-bound slang likewise follow the setting. Don't mix in words from other languages where ${promptName} has a natural equivalent; proper nouns, established loanwords, and a character's own code-switching in dialogue are fine.`;
}

function languageLine(code, scope) {
    const lang = languageInfo(code);
    return `Language: Write in ${lang.promptName}, ${scope}. This holds whatever language the reference or the user's instructions use. ${languageNotes(lang.promptName)} For names from another script, add the original form in parentheses on first mention, e.g. ${lang.nameExample}.`;
}

const SCOPE_TEMPLATE = 'including field labels and dialogue; section headers stay as listed';

// 템플릿 생성의 언어 범위 — 섹션 설명이 영어라 라벨까지 영어로 쓰는 경우가 있어 라벨 예시를 붙임
function templateScope(code) {
    const label = languageInfo(code).nameLabel;
    return label
        ? `including field labels (for example "- ${label}:" rather than "- Name:") and dialogue; section headers stay as listed`
        : SCOPE_TEMPLATE;
}
const SCOPE_SHEET = "for everything you fill in; keep the sheet's own labels and wording as they are";
const SCOPE_EXISTING = 'including field labels and dialogue; keep the existing section headers as they are';
// 기존 캐릭터 참고·자유 입력은 라벨과 헤더가 틀(원본)의 것이므로 그대로 둠
const SCOPE_EXISTING_KEEP = 'for all the content, including dialogue; keep the existing labels and section headers as they are';
const SCOPE_MIRROR = "for all the content, including dialogue; keep the model profile's labels and section headers as they are, in their original language";

function existingScope(gen) {
    return gen.isCustomSheet || keepsOwnTitle(gen) ? SCOPE_EXISTING_KEEP : SCOPE_EXISTING;
}
const TASK_CREATE = 'Create a new persona profile for {{user}}. "{{user}}" is only a placeholder; give the persona a real name.';
const TASK_CREATE_BOT = 'Create a new character profile for a roleplay bot, and give the character a real name.';
const TASK_CREATE_WORLD = 'Create the setting for a roleplay bot: the world the story takes place in, with no character profile. People appear only as part of the world, in the sections where they belong.';
const NO_TARGET_NOTE = 'There is no single target character: design {{user}} to fit the world in <reference>, as someone who could meet its characters. Wherever the instructions mention the target character, think of the characters and setting in the world information instead.';
const SETTING_TITLE = '# Setting';
const BASE_PERSONA_NOTE = 'The user chose one of their existing personas as a base, in <base_persona>. Build on it as the user\'s concept says (for example, a new persona in a similar vein, or the same persona fleshed out). If the concept doesn\'t say, keep its established facts and fill out the rest to fit the target character.';
const MULTI_CHARACTER_NOTE = 'If the concept asks for several main characters (a multi-character bot), write the full profile for each of them in turn. Side characters belong in the relevant sections, such as relationships, not in full profiles of their own.';

export function getEffectiveField(fieldId, mode = 'persona') {
    const settings = getSettings();
    const customDef = settings?.customFieldDefinitions?.[fieldId];
    if (customDef) {
        const base = PROFILE_FIELDS[fieldId] || {};
        return { ...base, ...customDef, id: fieldId };
    }
    const field = PROFILE_FIELDS[fieldId];
    if (!field) return null;
    if (mode === 'bot' && field.botDescription) {
        return { ...field, description: field.botDescription, descriptionKo: field.botDescriptionKo || field.descriptionKo };
    }
    return field;
}

// 세계관 항목 — 기본 항목(수정했으면 수정본) 또는 직접 추가한 항목
export function getEffectiveSettingField(fieldId) {
    const custom = getSettings()?.settingFieldDefinitions?.[fieldId];
    const base = SETTING_FIELDS[fieldId];
    if (custom) return { ...(base || {}), ...custom, id: fieldId };
    return base ? { ...base, id: fieldId } : null;
}

function getActiveSettingFields() {
    return (getSettings().settingFields || []).map(getEffectiveSettingField).filter(Boolean);
}

function getActiveFields() {
    const settings = getSettings();
    if (settings.templatePreset === 'choice') {
        return (settings.customFields || []).filter(id => getEffectiveField(id));
    }
    const preset = TEMPLATE_PRESETS[settings.templatePreset];
    return preset ? preset.fields : TEMPLATE_PRESETS.standard.fields;
}

// 모델이 섹션 헤더를 앞 헤더로 잘못 베낀 경우 바로잡기 (예: APPEARANCE 자리에 ## BASICS가 한 번 더)
// 헤더 수가 요청한 수와 같고, 그 자리의 헤더가 결과 어디에도 없을 때만 고침 (여러 인물 반복은 건드리지 않음)
export function repairDuplicateHeaders(text, expected) {
    const lines = String(text || '').split('\n');
    const headerLines = lines.map((line, idx) => (/^##[ \t]+\S/.test(line) ? idx : -1)).filter(idx => idx >= 0);
    if (headerLines.length !== expected.length) return text;

    const present = new Set(headerLines.map(idx => lines[idx].trim()));
    const seen = new Set();
    headerLines.forEach((lineIdx, position) => {
        const header = lines[lineIdx].trim();
        const wanted = expected[position];
        if (seen.has(header) && header !== wanted && !present.has(wanted)) {
            lines[lineIdx] = wanted;
            present.add(wanted);
        }
        seen.add(header);
    });
    return lines.join('\n');
}

const MD_HEADER = /^(#{1,6})[ \t]+(\S.*)$/;
// 모델이 ## 대신 굵은 줄로 제목을 쓴 경우 (예: **BASICS**)
const BOLD_HEADER = /^\*\*([^*\n]{1,80})\*\*:?[ \t]*$/;

// 섹션 헤더 찾기 — ## 헤더가 있으면 ## 기준, 마크다운 헤더가 전혀 없으면 굵은 제목 줄 기준
function findSectionHeaders(text) {
    const headers = [];
    let offset = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        const md = trimmed.match(MD_HEADER);
        if (md && line.startsWith('#')) headers.push({ level: md[1].length, index: offset, fullMatch: trimmed, bold: false });
        else if (BOLD_HEADER.test(trimmed) && line.startsWith('**')) headers.push({ level: 2, index: offset, fullMatch: trimmed, bold: true });
        offset += line.length + 1;
    }
    const markdown = headers.filter(h => !h.bold);
    if (!markdown.length) return headers;
    // ## 기준일 때 중간에 끼어 있는 "# 제목" 줄도 나눔 (앞 섹션 끝에 붙어 보이지 않게) — 제목으로 표시
    if (markdown.some(h => h.level === 2)) return markdown.filter(h => h.level <= 2).map(h => ({ ...h, title: h.level === 1 }));
    const level = Math.min(...markdown.map(h => h.level));
    return markdown.filter(h => h.level === level);
}

export function countMainSections(text) {
    return findSectionHeaders(String(text || '').trim()).filter(h => !h.title).length;
}

function isHeaderLine(line) {
    const trimmed = String(line || '').trim();
    return MD_HEADER.test(trimmed) || BOLD_HEADER.test(trimmed);
}

export function getSectionBody(section) {
    const content = String(section?.content || '').trim();
    return isHeaderLine(content.split('\n')[0]) ? content.replace(/^[^\n]*\n?/, '').trim() : content;
}

export function setSectionBody(section, body) {
    const content = String(section?.content || '').trim();
    const first = content.split('\n')[0];
    section.content = isHeaderLine(first) ? `${first}\n${body}` : body;
}

export function headerLabel(header) {
    return String(header || '').replace(/^#{1,6}\s+/, '').replace(/^\*\*([^*]+)\*\*:?$/, '$1').trim();
}

// LLM 응답을 섹션별로 파싱
// - 헤더 이름을 필드와 맞춰 보지 않고 위치로만 나눔 → 헤더가 틀리거나 번역돼도 내용은 항상 표시됨
// - ## 가 있으면 ## 기준 (### 소제목은 섹션 안에 유지), 없으면 가장 얕은 헤더, 그것도 없으면 굵은 제목 줄
// - 헤더가 전혀 없으면 전체를 한 덩어리로
export function parseResponse(response) {
    const text = String(response || '').trim();
    const splits = findSectionHeaders(text);

    if (!splits.length) {
        return { section_0: { header: '## PROFILE', content: text } };
    }

    const sections = {};
    let n = 0;

    const preamble = text.substring(0, splits[0].index).trim();
    if (preamble) {
        const firstLine = preamble.split('\n')[0].trim();
        sections[`section_${n++}`] = {
            header: isHeaderLine(firstLine) ? firstLine : '## PROFILE',
            content: preamble,
        };
    }

    for (let i = 0; i < splits.length; i++) {
        const end = (i + 1 < splits.length) ? splits[i + 1].index : text.length;
        sections[`section_${n++}`] = {
            header: splits[i].fullMatch,
            content: text.substring(splits[i].index, end).trim(),
        };
    }

    return sections;
}

function orderedSections(sections) {
    return Object.keys(sections || {})
        .sort((a, b) => parseInt(a.replace('section_', ''), 10) - parseInt(b.replace('section_', ''), 10))
        .map(key => sections[key]);
}

export function guessIconForHeader(headerText) {
    const lower = headerText.toLowerCase();
    // 세계관 항목 헤더는 그 항목의 아이콘 그대로
    const settingIds = [...Object.keys(SETTING_FIELDS), ...Object.keys(getSettings()?.settingFieldDefinitions || {})];
    const setting = settingIds.map(getEffectiveSettingField).find(field => field?.labelEn?.toLowerCase() === lower.trim());
    if (setting?.icon) return setting.icon;

    const iconMap = [
        { keywords: ['basic', '기본', '基本', '基本情報'], icon: 'fa-solid fa-id-card' },
        { keywords: ['appearance', '외모', '외형', '外見', '外貌'], icon: 'fa-solid fa-user' },
        { keywords: ['background', 'backstory', '배경', '過去', '背景', '背景故事'], icon: 'fa-solid fa-book-open' },
        { keywords: ['personality', '성격', '人格', '性格'], icon: 'fa-solid fa-gem' },
        { keywords: ['quirk', 'habit', '버릇', '습관', '癖', '怖'], icon: 'fa-solid fa-puzzle-piece' },
        { keywords: ['skill', 'abilit', '능력', '기술', 'スキル', '技能'], icon: 'fa-solid fa-bolt' },
        { keywords: ['relationship', '관계', '関係', '关系', '關係'], icon: 'fa-solid fa-heart' },
        { keywords: ['hidden desire', 'guilt', '숨겨진', '욕망', '秘密', '欲望'], icon: 'fa-solid fa-moon' },
        { keywords: ['speech', 'dialogue', '말투', '대사', '話し方', '台词', '台詞'], icon: 'fa-solid fa-comment-dots' },
        { keywords: ['nsfw appearance', 'intimate', 'nsfw 외모'], icon: 'fa-solid fa-eye-slash' },
        { keywords: ['sexual', 'romantic', '성적', '로맨틱', '性的'], icon: 'fa-solid fa-fire' },
        { keywords: ['ai guide', 'guideline', 'ai 가이드', 'AIガイド'], icon: 'fa-solid fa-robot' },
        { keywords: ['note', '노트', '메모', '참고', 'ノート', '备注', '備註'], icon: 'fa-solid fa-note-sticky' },
    ];

    for (const entry of iconMap) {
        if (entry.keywords.some(kw => lower.includes(kw))) {
            return entry.icon;
        }
    }

    return 'fa-solid fa-file-lines';
}

export function rebuildFullText() {
    const gen = state.currentGeneration;
    if (!gen) return;

    if (gen.isCustomSheet) {
        gen.fullText = gen.sections._custom?.content || '';
        return;
    }

    gen.fullText = orderedSections(gen.sections)
        .map(section => section?.content)
        .filter(Boolean)
        .join('\n\n');
}

export function updateFromEditedText(newText) {
    const gen = state.currentGeneration;
    if (!gen) return;

    if (newText !== gen.fullText) gen.resultKind = 'modified';
    gen.fullText = newText;
    refreshBotName(gen);
    gen.incomplete = null;
    gen.sections = gen.isCustomSheet
        ? { _custom: { header: '', content: newText } }
        : parseResponse(newText);
}

function checkCompleteness({ kind, truncated, expected = 0, text }) {
    const actual = countMainSections(text);
    if (truncated) return { kind, reason: 'length', expected, actual };
    if (expected > 0 && actual < expected) return { kind, reason: 'sections', expected, actual };
    return null;
}

function buildGenerateRequest(config = {}) {
    const settings = getSettings();
    const mode = config.mode || (settings.forgeMode === 'bot' ? 'bot' : 'persona');
    const isBot = mode === 'bot';
    const charData = state.selectedCharData;
    // 페르소나 모드: 캐릭터를 참고하지 않으면 고른 월드인포만 보고 만듦
    const noTarget = !isBot && !charData;
    if (noTarget && !(settings.includeWorldInfo && getSelectedEntries(state.wiBooks).length)) {
        throw new Error('기존 캐릭터를 고르거나, 월드인포를 켜고 참고할 항목을 골라 주십시오.');
    }
    if (!isBot && charData?.isManual && !String(charData.data?.description || '').trim()) {
        throw new Error('직접 입력한 기존 캐릭터의 설명을 입력해 주십시오.');
    }

    const language = settings.language || 'en';
    const lang = languageInfo(language);
    const conceptText = (config.conceptText || '').trim();
    const isGuided = settings.generationMode === 'guided' && !!conceptText;
    const additional = (config.additionalInstructions || '').trim();
    // 봇 모드에서 캐릭터 설정을 끄면 세계관만 (템플릿·설계 방향은 쓰지 않음)
    const worldOnly = isBot && settings.includeCharacter === false;
    const isSheetMode = !worldOnly && settings.templatePreset === 'custom';
    const isMirror = !worldOnly && settings.templatePreset === 'mirror';
    const sheetTemplate = isSheetMode ? (config.sheetTemplate || '') : '';
    const charLabel = isBot ? NEW_CHARACTER_LABEL : (getCharName(charData) || 'the target character');
    const direction = BOT_DIRECTIONS[settings.botDirection] ? settings.botDirection : 'relational';
    const personaId = selectedPersonaId(isBot);

    if (isSheetMode && !sheetTemplate.trim()) {
        throw new Error('자유 입력 양식이 비어 있습니다.');
    }
    const mirrorSource = isMirror ? describeMirrorSource(charData, isBot) : '';
    if (isMirror && !mirrorSource) {
        throw new Error(isBot
            ? '형식을 따를 프로필이 없습니다. 설명이 있는 "참고할 기존 캐릭터"나 직접 입력한 프로필, 또는 인물 프로필이 든 월드인포 항목을 고르거나 다른 템플릿을 선택해 주십시오.'
            : '형식을 따를 프로필이 없습니다. 기존 캐릭터 설명이 비어 있으면 인물 프로필이 든 월드인포 항목을 고르거나 다른 템플릿을 선택해 주십시오.');
    }

    const sources = isBot
        ? buildBotSourceBlocks(charData, personaId)
        : [buildReference(charData), basePersonaBlock(personaId, charLabel)].filter(Boolean);
    const hasBasePersona = sources.some(block => block.startsWith('<base_persona'));
    const hasNotes = sources.some(block => block.startsWith('<user_notes'));

    let task = worldOnly ? TASK_CREATE_WORLD : (isBot ? TASK_CREATE_BOT : TASK_CREATE);
    if (noTarget) task += `\n${NO_TARGET_NOTE}`;
    if (hasBasePersona) task += `\n${BASE_PERSONA_NOTE}`;
    if (isSheetMode) task += ' Fill in the sheet in <sheet_template>.';
    if (isBot) {
        if (!worldOnly) task += `\n${wrap('design_direction', getPrompt(BOT_DIRECTIONS[direction].slot))}`;
        if (hasNotes) task += '\nBuild on the user\'s notes in <user_notes>.';
        const nameNote = personaNameNote(personaId);
        if (nameNote) task += `\n${nameNote}`;
    }
    if (isGuided) {
        task += `\nThe user's concept for the ${worldOnly ? 'world' : (isBot ? 'character' : 'persona')}. Follow it, and fill in whatever it leaves open:\n${wrap('concept', normalizeMacros(conceptText, charLabel))}`;
    }
    if (additional) {
        task += `\nAdditional instructions for this version (where they conflict with the concept, follow these):\n${wrap('extra_instructions', normalizeMacros(additional, charLabel))}`;
    }
    // 자유 입력은 양식이 인물 구성을 정하므로 제외
    // 다인봇 — 인물마다 "# 이름" 줄로 나눠야 결과에서 구분됨 (기존 캐릭터 참고는 원본 틀의 제목을 따름)
    const multiCharacter = isBot && !worldOnly && !isSheetMode && (isGuided || additional);
    const settingFirst = isBot && !worldOnly && !isMirror && settings.includeSetting && getActiveSettingFields().length > 0;
    if (multiCharacter) {
        task += `\n${MULTI_CHARACTER_NOTE}`;
        if (settingFirst) task += ' Start each profile with its own `# Name` line.';
        else if (!isMirror) task += ' If you write several profiles, start each with its own `# Name` line.';
    }

    const parts = [...sources, wrap('task', task), matureContentBlock()].filter(Boolean);
    let fields = [];
    let finalLine;
    // 세계관 — 봇 모드에서 켰을 때만 (자유 입력·기존 캐릭터 참고는 양식이 정하므로 제외). 배경이 먼저라 프로필보다 앞에 씀
    const settingFields = worldOnly || (isBot && settings.includeSetting && !isSheetMode && !isMirror) ? getActiveSettingFields() : [];
    if (worldOnly && !settings.includeSetting) throw new Error('만들 것이 없습니다. "세계관 설정"이나 "캐릭터 설정" 중 하나 이상을 켜 주십시오.');
    if (worldOnly && !settingFields.length) throw new Error('세계관 항목을 하나 이상 골라 주십시오.');
    const settingHeaders = settingFields.map(field => `## ${field.labelEn}`);
    const hasSetting = settingHeaders.length > 0;
    const settingList = [
        `\`${SETTING_TITLE}\`: ${getPrompt('settingFormat')}`,
        ...settingFields.map((field, i) => `${i + 1}. \`${settingHeaders[i]}\`: ${field.description}`),
    ].join('\n');

    if (worldOnly) {
        parts.push(wrap('output_format', `${languageLine(language, templateScope(language))}

Sections, in this order. Use each header exactly as shown; the text after it says what the section covers.
${settingList}

Format:
${getPrompt('templateFormat')}`));
        finalLine = `Write the setting now: all ${settingFields.length} sections in order, in ${lang.promptName}, starting with \`${SETTING_TITLE}\` and with nothing before or after.`;
    } else if (isMirror) {
        parts.push(wrap('output_format', `${languageLine(language, SCOPE_MIRROR)}

Format: Use ${mirrorSource} as the model for the layout. Follow that layout: its sections, their order, its labels and markers, and its way of writing (lists or prose, line layout, and, unless <density> sets it, the level of detail). It is a model for structure only: write new content for this character, not a copy of that one. Leave out parts that don't fit this character, parts that are instructions for the AI rather than profile content (roleplay or formatting rules, system notes), and parts about the world rather than the character (setting overviews, locations, factions): the profile covers only this character, with setting details only where they concern them. Rename, adapt, or add items where this character needs it, but keep the overall structure recognizably similar.`));
        finalLine = `Write the profile now, in ${lang.promptName}, in the layout of the model profile, and output only the profile.`;
    } else if (isSheetMode) {
        parts.push(wrap('sheet_template', normalizeMacros(sheetTemplate, charLabel)));
        parts.push(wrap('output_format', `${languageLine(language, SCOPE_SHEET)}
Format: Reproduce the sheet exactly (same items, order, labels, symbols, and line layout) and fill in only the content. Do not add or remove items. The sheet's layout overrides any other formatting habit.`));
        finalLine = `Fill in the sheet now, in ${lang.promptName}, and output only the completed sheet.`;
    } else {
        fields = getActiveFields();
        if (!fields.length) throw new Error('작성할 항목이 없습니다. Choice 템플릿에서 항목을 선택해 주십시오.');
        const start = settingFields.length + 1;
        const sectionList = fields.map((id, idx) => {
            const field = getEffectiveField(id, mode);
            return `${start + idx}. \`## ${field.labelEn}\`: ${field.description}`;
        }).join('\n');
        const firstHeader = `## ${getEffectiveField(fields[0]).labelEn}`;
        const total = settingFields.length + fields.length;

        parts.push(wrap('output_format', `${languageLine(language, templateScope(language))}

Sections, in this order. Use each header exactly as shown${hasSetting ? ' (for `# Name`, the character\'s name in place of Name)' : ''}; the text after it says what the section covers.
${hasSetting ? `${settingList}\n\`# Name\`: the character profile.\n` : ''}${sectionList}

Format:
${getPrompt('templateFormat')}`));
        finalLine = hasSetting
            ? `Write it now: all ${total} sections in order, the setting and then the profile, in ${lang.promptName}, starting with \`${SETTING_TITLE}\` and with nothing before or after.`
            : `Write the profile now: all ${fields.length} sections in order, in ${lang.promptName}, starting with \`${firstHeader}\`${multiCharacter ? ' (or its `# Name` line if you write several profiles)' : ''} and with nothing before or after.`;
    }

    if (isBot && personaNameNote(personaId)) finalLine += ' Write {{user}} for the user\'s character, not the persona\'s name.';
    parts.push(finalLine);

    return {
        messages: [
            { role: 'system', content: coreSystemFor(mode, { worldOnly, fixedLayout: isMirror || isSheetMode }) },
            { role: 'user', content: parts.join('\n\n') },
        ],
        meta: {
            mode, charData, noTarget, language, isSheetMode, isMirror, sheetTemplate,
            conceptText: isGuided ? conceptText : '',
            worldOnly,
            expectedSections: fields.length || worldOnly ? settingHeaders.length + fields.length : 0,
            expectedHeaders: fields.length || worldOnly ? [...settingHeaders, ...fields.map(id => `## ${getEffectiveField(id, mode).labelEn}`)] : [],
            direction: isBot ? direction : '',
            personaId,
            wiNames: settings.includeWorldInfo ? getSelectedBookNames(state.wiBooks) : [],
        },
    };
}

function buildRegenRequest(sectionKey, instruction = '') {
    const gen = state.currentGeneration;
    if (!gen) throw new Error('생성된 페르소나가 없습니다.');

    const section = gen.sections[sectionKey];
    if (!section) throw new Error(`알 수 없는 섹션: ${sectionKey}`);

    const mode = modeOf(gen);
    const { charData, isSelected } = resolveGenerationCharacter();
    if (!charData && mode !== 'bot' && !gen.noTarget) throw new Error('캐릭터 데이터를 찾을 수 없습니다.');

    const lang = languageInfo(gen.language);
    const charLabel = mode === 'bot' ? (gen.charName || NEW_CHARACTER_LABEL) : (getCharName(charData) || 'the target character');
    const header = section.header.trim();

    let task = `Rewrite the \`${header}\` section of <current_profile>.\n- Keep it consistent with the other sections, and match their style, format, and level of detail.\n- Keep it about as long as the current version unless the instruction asks for more or less.`;
    if (mode === 'bot' && personaNameNote(gen.personaId)) task += `\n- ${personaNameNote(gen.personaId)}`;
    if (instruction.trim()) {
        task += `\n- Apply the user's instruction for this rewrite:\n${wrap('instruction', normalizeMacros(instruction, charLabel))}`;
    }

    const user = [
        // 월드인포는 설정 탭에서 같은 대상이 선택된 경우에만 포함
        ...sourceBlocksFor(gen, charData, isSelected),
        wrap('current_profile', gen.fullText),
        wrap('task', task),
        matureContentBlock(),
        wrap('output_format', `${languageLine(gen.language, existingScope(gen))}\nFormat: The same format as the other sections of <current_profile>.`),
        `Output only the rewritten section, in ${lang.promptName}, starting with the line \`${header}\`.`,
    ].filter(Boolean).join('\n\n');

    return {
        messages: [{ role: 'system', content: coreSystemForResult(gen) }, { role: 'user', content: user }],
        meta: { section, sectionTitle: headerLabel(header) },
    };
}

function buildModifyRequest(instruction) {
    const gen = state.currentGeneration;
    if (!gen?.fullText) throw new Error('수정할 프로필이 없습니다.');

    const mode = modeOf(gen);
    const { charData, isSelected } = resolveGenerationCharacter();
    const lang = languageInfo(gen.language);
    const charLabel = mode === 'bot' ? (gen.charName || NEW_CHARACTER_LABEL) : (getCharName(charData) || 'the target character');

    const task = `Revise <current_profile> according to the user's instruction:
${wrap('instruction', normalizeMacros(instruction, charLabel))}
- Apply the instruction fully. If it is broad (for example, "make her colder"), let the change show wherever it matters across the profile. If it is narrow (for example, "change the age"), change that and whatever depends on it.
- Leave everything the instruction doesn't touch as it is.
- Keep the overall length about the same unless the instruction asks otherwise.${mode === 'bot' && personaNameNote(gen.personaId) ? `\n- ${personaNameNote(gen.personaId)}` : ''}`;

    const user = [
        ...sourceBlocksFor(gen, charData, isSelected),
        wrap('current_profile', gen.fullText),
        wrap('task', task),
        matureContentBlock(),
        wrap('output_format', `${languageLine(gen.language, existingScope(gen))}\nFormat: The same format as <current_profile>.`),
        `Output the complete revised profile, in ${lang.promptName}, and nothing else.`,
    ].filter(Boolean).join('\n\n');

    return { messages: [{ role: 'system', content: coreSystemForResult(gen) }, { role: 'user', content: user }] };
}

// 그리팅 요청의 시스템 문장과 결과 블록 — 세계관만 만든 결과면 세계관용 역할과 규칙을 덧붙임
function greetingFrame(gen) {
    const rules = wrap('greeting_rules', getPrompt('greetingRules'));
    if (gen.worldOnly) {
        return {
            system: `${WORLD_GREETING_ROLE}\n\n${rules}\n\n${wrap('world_greeting_rules', getPrompt('worldGreetingRules'))}`,
            source: wrap('world_setting', gen.fullText),
        };
    }
    return { system: `${GREETING_ROLE}\n\n${rules}`, source: wrap('character_profile', gen.fullText) };
}

function buildGreetingRequest(options = {}) {
    const gen = state.currentGeneration;
    if (!gen?.fullText) throw new Error('먼저 캐릭터 프로필을 만들어 주십시오.');

    const { charData, isSelected } = resolveGenerationCharacter();
    const language = LANGUAGES[options.language] ? options.language : (gen.language || 'en');
    const lang = languageInfo(language);
    const customLength = String(options.customLength || '').trim();
    const lengthKey = options.length === 'custom' && customLength ? 'custom'
        : (GREETING_LENGTHS[options.length] && options.length !== 'custom' ? options.length : 'medium');
    const lengthText = lengthKey === 'custom' ? customLength : `${GREETING_LENGTHS[lengthKey].paragraphs} paragraphs.`;
    const concept = String(options.concept || '').trim();
    const botName = gen.charName || NEW_CHARACTER_LABEL;

    const narrated = gen.worldOnly ? 'everyone else' : 'the character';
    const pov = options.pov === 'second'
        ? `Second person for {{user}}: address {{user}} as "you" (in ${lang.promptName}, "${lang.you}"), and narrate ${narrated} in the third person. Write {{user}} only where their name is spoken.`
        : gen.worldOnly
            ? 'Omniscient third person: narrate the scene in the third person, with access to the inner thoughts of the people in it, and refer to the user\'s character as {{user}}.'
            : 'Omniscient third person: narrate the character in the third person, with access to their inner thoughts, and refer to the user\'s character as {{user}}.';

    const world = !!gen.worldOnly;
    let task = world
        ? `Write the opening message for a roleplay set in the world in <world_setting>.`
        : `Write the opening message for a roleplay with the character in <character_profile>.`;
    task += `
- Point of view: ${pov}
- Length: ${lengthText}`;
    const greetingNameNote = personaNameNote(gen.personaId);
    if (greetingNameNote) task += `\n- ${greetingNameNote}`;
    if (concept) {
        task += `\nThe user's idea for the opening scene. Follow it, and fill in whatever it leaves open:\n${wrap('scene_concept', normalizeMacros(concept, botName))}`;
    }

    const user = [
        ...buildBotSourceBlocks(charData, gen.personaId, { includeWorldInfo: isSelected }),
        greetingFrame(gen).source,
        wrap('task', task),
        matureContentBlock(),
        wrap('output_format', `Language: Write in ${lang.promptName}, including dialogue. This holds whatever language the profile, the reference, or the user's instructions use; if the profile is in another language, render names in ${lang.promptName} the standard way. ${languageNotes(lang.promptName)}
Format: The message exactly as it will appear in the chat: narration and dialogue only, with no title, labels, notes, or commentary. Leave out status panels, trackers, and other tagged blocks, even if the reference asks for them.`),
        `Write the opening message now, in ${lang.promptName}, and output only the message.`,
    ].filter(Boolean).join('\n\n');

    return {
        messages: [
            { role: 'system', content: greetingFrame(gen).system },
            { role: 'user', content: user },
        ],
        meta: { language, length: lengthKey, customLength: lengthKey === 'custom' ? customLength : '', pov: options.pov === 'second' ? 'second' : 'third', concept },
    };
}

function buildGreetingModifyRequest(instruction) {
    const gen = state.currentGeneration;
    const greeting = gen?.greeting;
    if (!greeting?.text) throw new Error('수정할 그리팅이 없습니다.');

    const { charData, isSelected } = resolveGenerationCharacter();
    const language = LANGUAGES[greeting.language] ? greeting.language : (gen.language || 'en');
    const lang = languageInfo(language);
    const botName = gen.charName || NEW_CHARACTER_LABEL;

    const task = `Revise <current_message> according to the user's instruction:
${wrap('instruction', normalizeMacros(instruction, botName))}
- Apply the instruction fully. If it is broad (for example, "make it tenser"), let the change show wherever it matters. If it is narrow (for example, "rewrite the last paragraph"), change that and whatever depends on it.
- Leave everything the instruction doesn't touch as it is, including the point of view, unless the instruction says otherwise.${personaNameNote(gen.personaId) ? `\n- ${personaNameNote(gen.personaId)}` : ''}`;

    const user = [
        ...buildBotSourceBlocks(charData, gen.personaId, { includeWorldInfo: isSelected }),
        greetingFrame(gen).source,
        wrap('current_message', greeting.text),
        wrap('task', task),
        matureContentBlock(),
        wrap('output_format', `Language: Write in ${lang.promptName}, including dialogue, unless the instruction asks for another language. ${languageNotes(lang.promptName)}
Format: The complete revised message exactly as it will appear in the chat: narration and dialogue only, with no title, labels, notes, or commentary. Leave out status panels, trackers, and other tagged blocks, even if the reference asks for them.`),
        `Output the complete revised opening message, in ${lang.promptName}, and nothing else.`,
    ].filter(Boolean).join('\n\n');

    return {
        messages: [
            { role: 'system', content: greetingFrame(gen).system },
            { role: 'user', content: user },
        ],
    };
}

function buildTranslateRequest(targetLang) {
    const gen = state.currentGeneration;
    if (!gen?.fullText) throw new Error('번역할 프로필이 없습니다.');

    const source = languageInfo(gen.language);
    const target = languageInfo(targetLang);
    const rules = getPrompt('translateRules').replaceAll('{name_example}', target.nameExample);
    // 템플릿·Choice·기존 캐릭터 참고의 헤더는 그대로 둠 (자유 입력·직접 추가는 헤더까지 번역)
    const keepHeaders = gen.isCustomSheet || gen.templateId === 'manual' ? '' : ' Keep the "##" header lines unchanged.';

    return {
        messages: [
            { role: 'system', content: `${TRANSLATOR_ROLE}\n\n${wrap('translation_rules', rules)}` },
            {
                role: 'user',
                content: `${wrap('source_text', gen.fullText)}\n\nTranslate <source_text> from ${source.promptName} to ${target.promptName}.${keepHeaders} Output only the translation.`,
            },
        ],
    };
}

// 그리팅 번역 — 프로필이 대상 언어로 되어 있으면 이름·용어 표기를 프로필에 맞춤 (본문에는 원문 괄호 표기를 붙이지 않음)
function buildGreetingTranslateRequest(sourceLang, targetLang) {
    const gen = state.currentGeneration;
    const source = languageInfo(sourceLang);
    const target = languageInfo(targetLang);
    const rules = getPrompt('translateRules').replaceAll('{name_example}', target.nameExample);
    const matchProfile = (gen.language || 'en') === targetLang;
    const tag = gen.worldOnly ? 'world_setting' : 'character_profile';
    const naming = matchProfile
        ? `Render names and in-world terms the same way as <${tag}>`
        : `Use the standard ${target.promptName} rendering of names and in-world terms`;
    const parts = [
        ...(matchProfile ? [wrap(tag, gen.fullText)] : []),
        wrap('source_text', gen.greeting.text),
        `<source_text> is the opening message of a roleplay chat. Translate it from ${source.promptName} to ${target.promptName}. ${naming}, without adding the original forms in parentheses. Output only the translation.`,
    ];
    return [
        { role: 'system', content: `${TRANSLATOR_ROLE}\n\n${wrap('translation_rules', rules)}` },
        { role: 'user', content: parts.join('\n\n') },
    ];
}

// ===== 대화형 서포터 — 지금 결과를 두고 작가와 이야기하는 대장간 캐릭터 =====

// 쌍둥이라 성별마다 이름이 다름 — gender를 안 주면 설정의 성별
export function supporterName(gender) {
    const male = (gender || getSettings()?.supporterGender) === 'male';
    return getPrompt(male ? 'supporterNameMale' : 'supporterNameFemale').trim()
        || (male ? DEFAULT_SUPPORTER_NAME_MALE : DEFAULT_SUPPORTER_NAME_FEMALE);
}

// 이 대화의 성별 (대화마다 처음 정한 성별 그대로, 예전 대화는 설정의 성별)
function supportGenderOf(gen) {
    return (gen?.supportGender || getSettings()?.supporterGender) === 'male' ? 'male' : 'female';
}

// 서포터가 보는 자료 — 지금 결과(프로필·세계관·그리팅·컨셉)와, 결과를 만들 때 참고한 자료
function supportSources(gen) {
    const { charData, isSelected } = resolveGenerationCharacter();
    const blocks = sourceBlocksFor(gen, charData, isSelected);
    if (modeOf(gen) === 'persona' && gen.personaId) {
        const base = basePersonaBlock(gen.personaId, getCharName(charData) || 'the target character');
        if (base) blocks.push(base);
    }
    return { blocks, charData, isSelected };
}

// 대화창 위에 보여 줄 "보고 있는 것" 목록
export function describeSupportMaterial() {
    const gen = state.currentGeneration;
    if (!gen?.fullText) return [];
    const items = [gen.worldOnly ? '세계관' : '프로필'];
    if (gen.greeting?.text) items.push('그리팅');
    if (gen.conceptText) items.push('컨셉');
    const { blocks } = supportSources(gen);
    const text = blocks.join('\n');
    const refs = [];
    if (text.includes('<user_persona') || text.includes('<base_persona')) refs.push('페르소나');
    const charName = text.match(/<character name="([^"]+)"/)?.[1];
    if (charName) refs.push(`캐릭터 ${charName}`);
    else if (text.includes('<character>')) refs.push('캐릭터');
    if (text.includes('<user_notes')) refs.push('직접 입력한 설정');
    const wi = (text.match(/<entry name=/g) || []).length;
    if (wi) refs.push(`월드인포 ${wi}개 항목`);
    if (refs.length) items.push(`참고 자료(${refs.join(', ')})`);
    return items;
}

function supportMaterialKind(gen) {
    if (gen.worldOnly) return 'a world setting for a roleplay bot';
    if (modeOf(gen) === 'bot') return /^#[ \t]+Setting[ \t]*$/im.test(gen.fullText) ? 'a character profile for a roleplay bot, with its world setting' : 'a character profile for a roleplay bot';
    return 'a persona profile for {{user}}, the character the writer will play opposite the target character';
}

// chat: [{ role: 'user' | 'assistant', text }] — 화면에만 있는 첫 인사는 빼고 넘김
export function buildSupportRequest(chat = []) {
    const gen = state.currentGeneration;
    if (!gen?.fullText) throw new Error('먼저 결과를 만들거나 기록에서 불러오십시오.');
    const settings = getSettings();
    const mode = modeOf(gen);
    const male = supportGenderOf(gen) === 'male';
    const name = supporterName(male ? 'male' : 'female');
    const address = String(settings.supporterUserName || '').trim();

    const profile = getPrompt('supporterProfile')
        .replaceAll('{trait}', getPrompt(male ? 'supporterTraitMale' : 'supporterTraitFemale'))
        .replaceAll('{look}', getPrompt(male ? 'supporterLookMale' : 'supporterLookFemale'))
        .replaceAll('{name}', name)
        .replaceAll('{gender}', male ? 'man' : 'woman')
        .replaceAll('{sibling}', male ? 'sister' : 'brother')
        .replaceAll('{twin}', supporterName(male ? 'female' : 'male'));
    const addressLine = address
        ? `Call the writer "${address}".`
        : 'The writer hasn\'t given a name; call them 작가님, or leave the address out.';
    // 작가 본인 정보 (적었을 때만) — {{user}}와 헷갈리지 않게 따로 표시
    const writerGender = { female: 'a woman', male: 'a man' }[settings.supporterUserGender] || '';
    const writerIntro = String(settings.supporterUserIntro || '').trim();
    const writerLines = [
        writerGender ? `The writer is ${writerGender}.` : '',
        writerIntro ? `What the writer says about themselves (the writer, not {{user}}):\n${wrap('writer_intro', writerIntro)}` : '',
    ].filter(Boolean).join('\n');

    // 작성 원칙·문체 규칙·분량·추가 지침은 결과의 모드에 맞는 기존 설정을 그대로 씀 (판단 기준으로)
    const principles = getPrompt(gen.worldOnly ? 'worldPrinciples' : (mode === 'bot' ? 'botPrinciples' : 'principles'));
    const style = getPrompt('writingStyle');
    const density = densityBlock({ worldOnly: !!gen.worldOnly, fixedLayout: !!gen.isCustomSheet || keepsOwnTitle(gen) });
    const guidelines = getPrompt(mode === 'bot' ? 'botGuidelines' : 'guidelines');
    const craft = [
        'The forge writes this material by these notes. Use them when you judge it or suggest changes; you don\'t need to recite them.',
        principles && wrap('principles', principles),
        style && wrap('writing_style', style),
        density,
        guidelines && wrap('user_guidelines', `${USER_GUIDELINES_INTRO}\n${guidelines}`),
    ].filter(Boolean).join('\n');

    const lang = languageInfo(gen.language);
    const material = [
        gen.conceptText ? wrap('concept', gen.conceptText) : '',
        wrap(gen.worldOnly ? 'setting' : 'profile', gen.fullText),
        gen.greeting?.text ? wrap('greeting', gen.greeting.text) : '',
    ].filter(Boolean).join('\n');

    const { blocks } = supportSources(gen);
    const system = [
        profile,
        writerLines ? `${addressLine}\n${writerLines}` : addressLine,
        wrap('rules', `${getPrompt('supporterRules')}\n${SUPPORTER_FACE_RULE}`),
        wrap('craft_notes', craft),
        ...blocks,
        wrap('material', material, ` kind="${escapeAttr(supportMaterialKind(gen))}" language="${escapeAttr(lang.promptName)}"`),
        matureContentBlock(),
    ].filter(Boolean).join('\n\n');

    const messages = [{ role: 'system', content: system }];
    for (const message of chat) {
        const text = String(message?.text || '').trim();
        if (!text) continue;
        const assistant = message.role === 'assistant';
        // 지난 답에도 표정 태그를 붙여 둠 (모델이 계속 같은 형식으로 답하게)
        messages.push({ role: assistant ? 'assistant' : 'user', content: assistant ? `<face>${faceOf(message.face)}</face>\n${text}` : text });
    }
    return { messages };
}

function faceOf(value) {
    return SUPPORTER_FACES.some(face => face.id === value) ? value : 'neutral';
}

const FACE_ALIASES = {
    happy: 'smile', pleased: 'smile', satisfied: 'smile', smiling: 'smile', grin: 'smile', excited: 'smile',
    surprise: 'surprised', shocked: 'surprised', realization: 'surprised', realized: 'surprised', aha: 'surprised',
    embarrassed: 'shy', flustered: 'shy', blush: 'shy', blushing: 'shy',
};

// 답에서 표정 태그를 떼어 냄 — 없거나 모르는 표정이면 기본 표정
export function splitSupportFace(text) {
    let face = '';
    const body = String(text || '').replace(/<(face|expression|mood)>\s*([^<]*?)\s*<\/\1>\s*/gi, (_, _tag, value) => {
        const key = value.toLowerCase();
        face ||= FACE_ALIASES[key] || key;
        return '';
    }).trim();
    return { text: body, face: faceOf(face) };
}

export async function sendSupportMessage(chat, { signal } = {}) {
    const { messages } = buildSupportRequest(chat);
    if (messages.length < 2 || messages.at(-1).role !== 'user') throw new Error('보낼 메시지가 없습니다.');
    const settings = getSettings();
    const { text } = await callGenerationAPI(messages, {
        signal, label: `${supporterName(supportGenderOf(state.currentGeneration))} 대화`,
        connectionProfile: settings.supporterProfile || undefined,
    });
    if (signal?.aborted) throw cancelledError();
    // 추론 내용이 본문에 섞여 온 경우만 걷어 냄 (변경안 태그는 그대로)
    return splitSupportFace(String(text || '').replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, ''));
}

// ===== 서포터 변경안 바로 적용 — API 호출 없이, 원문을 찾아 대체안으로 바꿈 =====

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 원문 위치 — 그대로 없으면 공백·줄바꿈·따옴표 모양만 달라도 찾음
// (from: 대상 섹션 제목 위치 — 같은 문장이 여러 섹션에 있으면 그 섹션 것부터)
function locateText(text, needle, from = 0) {
    const words = needle.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const pattern = new RegExp(words
        .map(word => escapeRegex(word).replace(/["“”]/g, '["“”]').replace(/['‘’]/g, "['‘’]"))
        .join('\\s+'), 'g');
    for (const start of from > 0 ? [from, 0] : [0]) {
        const exact = text.indexOf(needle, start);
        if (exact >= 0) return { start: exact, end: exact + needle.length };
        pattern.lastIndex = start;
        const match = pattern.exec(text);
        if (match) return { start: match.index, end: match.index + match[0].length };
    }
    return null;
}

function sectionOffset(text, target) {
    const name = String(target || '').replace(/^#+/, '').trim();
    if (!name) return 0;
    return new RegExp(`^#{1,6}[ \\t]*${escapeRegex(name)}[ \\t]*$`, 'im').exec(text)?.index || 0;
}

function replaceAt(text, place, replacement) {
    return text.slice(0, place.start) + replacement + text.slice(place.end);
}

// edit: { target, original, revised } — 성공하면 되돌리기 정보를 돌려줌
export function applySupportEdit(edit) {
    const gen = state.currentGeneration;
    const original = String(edit?.original || '').trim();
    const revised = String(edit?.revised || '').trim();
    if (!gen?.fullText) throw new Error('적용할 결과가 없습니다.');
    if (!original || !revised) throw new Error('원문이나 대체안이 비어 있어 바로 적용할 수 없습니다.');

    const hasGreeting = modeOf(gen) === 'bot' && !!gen.greeting?.text;
    const greetingFirst = /greeting|그리팅|first message|첫\s*메시지/i.test(edit.target || '');
    const order = hasGreeting ? (greetingFirst ? ['greeting', 'profile'] : ['profile', 'greeting']) : ['profile'];
    for (const kind of order) {
        const source = kind === 'greeting' ? gen.greeting.text : gen.fullText;
        const place = locateText(source, original, kind === 'profile' ? sectionOffset(source, edit.target) : 0);
        if (!place) continue;
        const next = replaceAt(source, place, revised);
        if (kind === 'greeting') {
            // 그리팅은 새 버전으로 쌓음 (이전 버전으로 넘겨 볼 수 있게)
            const previous = gen.greeting;
            const added = addGreetingVersion(gen, { ...previous, text: next, truncated: false });
            return { kind, gen, previous, added };
        }
        const before = { text: gen.fullText, resultKind: gen.resultKind, incomplete: gen.incomplete };
        updateFromEditedText(next);
        return { kind, gen, before, after: gen.fullText };
    }
    throw new Error('지금 결과에서 원문을 찾지 못했습니다. 이미 바뀌었거나, 원문이 조금 다르게 옮겨졌을 수 있습니다. 남매에게 지금 글을 기준으로 다시 써 달라고 해 보십시오.');
}

// 적용한 뒤로 결과가 그대로일 때만 되돌릴 수 있음
export function canUndoSupportEdit(info) {
    const gen = state.currentGeneration;
    if (!info || info.gen !== gen) return false;
    return info.kind === 'greeting' ? gen.greeting === info.added : gen.fullText === info.after;
}

export function undoSupportEdit(info) {
    if (!canUndoSupportEdit(info)) return false;
    const gen = info.gen;
    if (info.kind === 'greeting') {
        const list = greetingList(gen);
        list.splice(list.indexOf(info.added), 1);
        gen.greeting = list.includes(info.previous) ? info.previous : (list.at(-1) || null);
        return true;
    }
    updateFromEditedText(info.before.text);
    gen.resultKind = info.before.resultKind;
    gen.incomplete = info.before.incomplete;
    return true;
}

export function buildPreview(kind, options = {}) {
    const gen = state.currentGeneration;
    const needResult = () => {
        if (!gen?.fullText) throw new Error('먼저 프로필을 생성하거나 기록에서 불러오십시오.');
    };

    if (kind === 'generate') {
        const title = isBotMode() ? '봇 캐릭터 생성 요청' : '페르소나 생성 요청';
        return { items: [{ title, messages: buildGenerateRequest(options).messages }], note: '' };
    }
    if (kind === 'greeting') {
        needResult();
        if (modeOf(gen) !== 'bot') throw new Error('그리팅은 봇 캐릭터 결과에서만 만들 수 있습니다. 봇 결과를 생성하거나 기록에서 불러오십시오.');
        const settings = getSettings();
        const { messages } = buildGreetingRequest({
            language: options.greetingLanguage || gen.language,
            length: settings.greetingLength,
            customLength: settings.greetingLengthCustom,
            pov: settings.greetingPov,
            concept: options.greetingConcept || '',
        });
        return { items: [{ title: '그리팅 요청', messages }], note: '' };
    }
    if (kind === 'support') {
        needResult();
        const text = (options.supportText || '').trim() || '(여기에 입력한 메시지가 들어갑니다)';
        const chat = [...(gen.supportChat || []).filter(m => !m.local), { role: 'user', text }];
        return { items: [{ title: `${supporterName(supportGenderOf(gen))} 대화 요청`, messages: buildSupportRequest(chat).messages }], note: '지금까지의 대화 뒤에 새 메시지를 붙인 예시입니다.' };
    }
    if (kind === 'greetingModify') {
        needResult();
        if (!gen.greeting?.text) throw new Error('먼저 그리팅을 만들어 주십시오.');
        const instructions = (options.greetingInstructions || '').trim() || '(여기에 입력한 수정 지시가 들어갑니다)';
        return { items: [{ title: '그리팅 수정 요청', messages: buildGreetingModifyRequest(instructions).messages }], note: '' };
    }
    if (kind === 'regen') {
        needResult();
        const keys = Object.keys(gen.sections).filter(k => k.startsWith('section_'));
        if (gen.isCustomSheet || !keys.length) throw new Error('자유 입력 결과는 섹션 재생성을 쓰지 않습니다.');
        const { messages, meta } = buildRegenRequest(keys[0], '');
        return { items: [{ title: `섹션 재생성 — ${meta.sectionTitle}`, messages }], note: '첫 번째 섹션 기준 예시입니다.' };
    }
    if (kind === 'translate') {
        needResult();
        let targetLang = options.targetLang || '';
        if (!targetLang || targetLang === gen.language) {
            targetLang = Object.keys(LANGUAGES).find(code => code !== gen.language) || 'en';
        }
        return { items: [{ title: `번역 요청 (${languageInfo(targetLang).label})`, messages: buildTranslateRequest(targetLang).messages }], note: '' };
    }
    if (kind === 'modify') {
        needResult();
        const instructions = (options.instructions || '').trim() || '(여기에 입력한 수정 지시가 들어갑니다)';
        return { items: [{ title: '전체 수정 요청', messages: buildModifyRequest(instructions).messages }], note: '' };
    }
    throw new Error(`알 수 없는 미리보기: ${kind}`);
}

export function describeStructure(kind, { conceptText = '' } = {}) {
    const settings = getSettings();
    const gen = state.currentGeneration;
    const hasResult = !!gen?.fullText;
    const isBot = kind === 'generate' ? settings.forgeMode === 'bot' : (kind === 'greeting' || kind === 'greetingModify' || modeOf(gen) === 'bot');
    const target = state.selectedCharData;
    const items = [];
    const add = (where, name, editable, desc, included = true, reason = '') => items.push({ where, name, editable, desc, included, reason });
    const density = DENSITY_LEVELS[settings.density] || DENSITY_LEVELS.default;
    const addStyle = () => add('system', '문체 규칙', true, '<writing_style> — 기계적 비유·과장된 비유·반복·낡은 야설 어휘 줄이기', !!getPrompt('writingStyle'), '비어 있음');
    const addMature = () => add('user', 'NSFW 지침 (베타)', true, '<smut_guidance> — 작업 지시 뒤(출력 형식 앞), 노골적인 내용을 더 적극적으로',
        !!settings.matureContent && !!getPrompt('matureContent'), settings.matureContent ? '비어 있음' : '설정 탭에서 꺼짐');
    const addDensity = () => add('system', '분량', true,
        density.slot ? `<density> — ${density.label}: ${density.desc}` : '<density> — 밸런스형·압축형을 골랐을 때',
        !!densityBlock(), density.slot ? '비어 있음' : '설정 탭에서 기본');

    if (kind === 'translate') {
        add('system', '번역가 역할', false, '문학 번역가 역할과 성인 픽션 안내');
        add('system', '번역 규칙', true, '<translation_rules> — 배치 유지, 말투 살리기, 이름 병행 표기');
        add('user', '원문', false, '<source_text> — 지금 결과 전체', hasResult, hasResult ? '' : '생성된 프로필 없음');
        add('user', '번역 지시', false, '원본·대상 언어, 템플릿 결과면 "## 헤더 유지"');
        return items;
    }

    const wiEntries = getSelectedEntries(state.wiBooks).length;
    const wiIncluded = !!settings.includeWorldInfo && wiEntries > 0;
    const wiReason = settings.includeWorldInfo ? '고른 항목 없음' : '월드인포 꺼짐';

    const worldOnly = kind === 'generate' ? isBot && settings.includeCharacter === false : !!gen?.worldOnly;

    // 참고 자료 순서: 월드인포 → 페르소나 → 캐릭터 (직접 입력한 캐릭터는 사용자 메모로 <reference> 바로 뒤)
    const addBotSources = () => {
        const personaId = kind === 'generate' ? selectedPersonaId(true) : gen?.personaId;
        const persona = findPersona(personaId);
        const refChar = kind === 'generate'
            ? (target && !target.isManual ? target : null)
            : (gen?.charAvatar ? { name: gen.refName || gen.charAvatar } : null);
        const notes = kind === 'generate' ? !!target?.isManual : !!gen?.manualCharacter;
        add('user', '참고 자료 — 월드인포', false, '<world_info> — 고른 월드인포 항목', wiIncluded, wiReason);
        add('user', '참고 자료 — 페르소나', false, '<user_persona> — 고른 페르소나(또는 직접 입력)의 설명',
            !!persona?.description.trim(), personaId ? '설명이 비어 있음' : '고르지 않음');
        add('user', '참고 자료 — 캐릭터', false,
            notes ? '<user_notes> — 직접 입력한 설정·메모 (사용자 메모로 취급)' : '<character> — 캐릭터 설명 + 켠 카드 항목',
            !!refChar || notes, '참고하지 않음');
    };
    const greetingSource = () => (worldOnly
        ? add('user', '세계관 설정', false, '<world_setting> — 지금 결과 전체', hasResult, '생성된 결과 없음')
        : add('user', '캐릭터 프로필', false, '<character_profile> — 지금 결과 전체', hasResult, '생성된 프로필 없음'));
    const greetingSystem = (note) => {
        add('system', '작성자 역할', false, worldOnly ? '세계관을 내레이션하는 롤플레이의 그리팅을 쓰는 작가 역할, 성인 픽션 안내' : '그리팅을 쓰는 작가 역할, 성인 픽션 안내, 참고 자료 취급');
        add('system', '그리팅 작성 규칙', true, note);
        if (worldOnly) add('system', '세계관 그리팅 규칙', true, '<world_greeting_rules> — 주인공 대신 세계를 내레이션, 설명 대신 장면으로');
    };

    if (kind === 'greetingModify') {
        greetingSystem('<greeting_rules> — 고칠 때도 같은 규칙을 지킴');
        addBotSources();
        greetingSource();
        add('user', '현재 그리팅', false, '<current_message> — 지금 그리팅', !!gen?.greeting?.text, '그리팅 없음');
        add('user', '작업 지시', false, '<task> — 입력한 수정 지시(<instruction>) 적용 규칙');
        addMature();
        add('user', '출력 형식', false, '<output_format> — 언어, 채팅에 그대로 쓸 본문만');
        add('user', '마지막 확인', false, '전체를 고친 본문만 출력');
        return items;
    }

    if (kind === 'greeting') {
        greetingSystem('<greeting_rules> — 흥미 유발, 프로필 읊지 않기, 보여주기, {{user}} 대신 쓰지 않기');
        addBotSources();
        greetingSource();
        add('user', '작업 지시', false, '<task> — 시점, 길이(문단 수 또는 직접 입력), 장면 컨셉(<scene_concept>, 적었을 때만)');
        addMature();
        add('user', '출력 형식', false, '<output_format> — 언어, 채팅에 그대로 쓸 본문만');
        add('user', '마지막 확인', false, '언어와 "본문만 출력"을 한 줄로 다시 확인');
        return items;
    }

    if (isBot && worldOnly) {
        const guidelines = getPrompt('botGuidelines');
        add('system', '역할과 창작 맥락 (세계관만)', true, '세계관 설계자 역할, 성인 픽션 안내');
        add('system', '작성 원칙 (세계관만)', true, '<principles> — 들어서기 쉽고, 장면을 움직일 거리와 일관된 규칙이 있는 세계', !!getPrompt('worldPrinciples'), '비어 있음');
        addStyle();
        add('system', '자료 규칙 (세계관만)', true, '<source_rules> — 참고 자료를 바탕으로 세계 넓히기, 충돌 시 우선순위');
        addDensity();
        add('system', '추가 지침 (봇)', true, '<user_guidelines> — 기본 지시보다 우선', !!guidelines, '작성하지 않음');
        addBotSources();
    } else if (isBot) {
        const guidelines = getPrompt('botGuidelines');
        add('system', '역할과 창작 맥락 (봇)', true, '봇 캐릭터 디자이너 역할, 성인 픽션 안내');
        add('system', '작성 원칙 (봇)', true, '<principles> — 입체적이고 스스로 움직이는 인물을 만드는 기준', !!getPrompt('botPrinciples'), '비어 있음');
        addStyle();
        add('system', '자료 규칙 (봇)', true, '<source_rules> — 페르소나·기존 캐릭터·월드인포, 충돌 시 우선순위');
        addDensity();
        add('system', '추가 지침 (봇)', true, '<user_guidelines> — 기본 지시보다 우선', !!guidelines, '작성하지 않음');
        addBotSources();
    } else {
        const guidelines = getPrompt('guidelines');
        add('system', '역할과 창작 맥락 (페르소나)', true, '캐릭터 디자이너 역할, 성인 픽션 안내');
        add('system', '작성 원칙 (페르소나)', true, '<principles> — 입체적인 인물을 만드는 기준', !!getPrompt('principles'), '비어 있음');
        addStyle();
        add('system', '자료 규칙 (페르소나)', true, '<source_rules> — 참고 자료·{{user}} 설정, 충돌 시 우선순위');
        add('system', '스포일러 방지 (페르소나)', true, '<spoiler_policy> — 기존 캐릭터의 비밀을 드러내지 않기',
            !!settings.spoilerProtection && !!getPrompt('spoiler'), settings.spoilerProtection ? '비어 있음' : '설정 탭에서 꺼짐');
        addDensity();
        add('system', '추가 지침 (페르소나)', true, '<user_guidelines> — 기본 지시보다 우선', !!guidelines, '작성하지 않음');
        add('user', '참고 자료 — 월드인포', false, '<world_info> — 고른 월드인포 항목', wiIncluded, wiReason);
        add('user', '참고 자료 — 캐릭터', false,
            target?.isManual ? '<character> — 직접 입력한 이름·설명' : '<character> — 캐릭터 설명 + 켠 카드 항목',
            !!target, '캐릭터 미선택');
        if (kind === 'generate') {
            const personaId = selectedPersonaId(false);
            add('user', '참고 자료 — 페르소나', false, '<base_persona> — 바탕으로 삼을 페르소나 (생성할 때만)',
                !!findPersona(personaId)?.description.trim(), personaId ? '설명이 비어 있음' : '고르지 않음');
        }
    }

    if (kind === 'generate') {
        const isSheet = !worldOnly && settings.templatePreset === 'custom';
        const isMirror = !worldOnly && settings.templatePreset === 'mirror';
        add('user', '작업 지시', false, worldOnly ? '<task> — 새 세계관 만들기 (캐릭터 프로필 없이)' : (isBot ? '<task> — 새 봇 캐릭터 만들기' : '<task> — 새 프로필 만들기'));
        if (isBot && !worldOnly) {
            const direction = BOT_DIRECTIONS[settings.botDirection] || BOT_DIRECTIONS.relational;
            add('user', `설계 방향 — ${direction.label}`, true, '<design_direction> — 설정 탭에서 고른 방향');
        }
        const guided = settings.generationMode === 'guided';
        add('user', '컨셉 설명', false, '<concept> — 가이드 모드에서 입력한 컨셉',
            guided && !!conceptText.trim(), guided ? '컨셉 칸이 비어 있음' : '자유 생성 모드');
        add('user', '재생성 지시', false, '<extra_instructions> — 전체 재생성 때 입력한 새 지시', false, '전체 재생성에서만');
        addMature();
        const settingOn = (worldOnly || !!settings.includeSetting) && getActiveSettingFields().length > 0;
        const addSetting = () => add('user', '세계관 설정 (봇)', true, '<output_format> 섹션 목록 맨 앞 — # Setting 설명 한 줄 (항목은 설정 탭에서 고른 것)',
            settingOn && !isSheet && !isMirror, !settingOn ? '설정 탭에서 꺼짐 또는 항목 없음' : '자유 입력·기존 캐릭터 참고(Mirror)에는 안 들어감');
        if (isMirror) {
            add('user', '출력 형식', false, isBot
                ? '<output_format> — 언어, 참고할 캐릭터(또는 직접 입력) 프로필의 형식 따르기'
                : '<output_format> — 언어, 캐릭터 설명의 형식 따르기');
            if (isBot) addSetting();
        } else if (isSheet) {
            add('user', '시트 양식', false, '<sheet_template> — 자유 입력에 적은 양식');
            add('user', '출력 형식', false, '<output_format> — 언어, 시트 재현 규칙');
            if (isBot) addSetting();
        } else {
            add('user', '출력 형식', false, worldOnly ? '<output_format> — 언어, 섹션 목록 (세계관 항목)' : '<output_format> — 언어, 섹션 목록 (템플릿)');
            if (isBot) addSetting();
            add('user', '템플릿 서식 규칙', true, '<output_format> — 섹션 내 하위 항목에 대한 작성 서식 규칙');
        }
        add('user', '마지막 확인', false, '언어·섹션 수·첫 헤더를 한 줄로 다시 확인');
        return items;
    }

    add('user', '현재 프로필', false, '<current_profile> — 지금 결과 전체', hasResult, '생성된 프로필 없음');
    if (kind === 'regen') {
        add('user', '작업 지시', false, '<task> — 섹션 하나 다시 쓰기 + 입력한 지시(<instruction>)');
    } else {
        add('user', '작업 지시', false, '<task> — 입력한 수정 지시(<instruction>) 적용 규칙');
    }
    addMature();
    add('user', '출력 형식', false, '<output_format> — 언어, 기존 서식 유지');
    add('user', '마지막 확인', false, '출력할 범위와 언어를 한 줄로 다시 확인');
    return items;
}

export function markModified() {
    if (state.currentGeneration) state.currentGeneration.resultKind = 'modified';
}

async function requestText(op, messages, label) {
    const { text, truncated } = await callGenerationAPI(messages, { signal: op.signal, label });
    if (!isCurrentOperation(op)) throw cancelledError();

    const scene = String(label).startsWith('그리팅');
    const cleaned = cleanGeneratedText(text, { scene });
    if (!cleaned) throw new Error('API에서 빈 응답을 받았습니다.');
    // 거절문이면 결과로 쓰지 않음 (화면·기록에 프로필처럼 남지 않게)
    if (looksLikeRefusal(cleaned, { scene })) {
        const snippet = cleaned.replace(/\s+/g, ' ').slice(0, 80);
        throw new Error(`모델이 요청을 거절한 것 같습니다. 다시 시도하거나 다른 모델·연결 프로필로 시도해 보십시오. (받은 답: "${snippet}${cleaned.length > 80 ? '…' : ''}")`);
    }
    return { text: cleaned, truncated };
}

export async function generatePersona(config = {}) {
    if (state.selectedCharData) await ensureFullCharacter(state.selectedCharData);
    const { messages, meta } = buildGenerateRequest(config);
    const settings = getSettings();
    const isBot = meta.mode === 'bot';
    const op = beginOperation();

    try {
        log(`Generating ${meta.mode} (template: ${settings.templatePreset}, lang: ${meta.language}, mode: ${settings.generationMode})`);

        const received = await requestText(op, messages, isBot ? '봇 생성' : '생성');
        const truncated = received.truncated;
        const repaired = meta.expectedHeaders.length ? repairDuplicateHeaders(received.text, meta.expectedHeaders) : received.text;
        // 자유 입력·기존 캐릭터 참고는 양식(원본)의 제목 그대로 둠
        const text = meta.isSheetMode || meta.isMirror ? repaired : tidyTitleLines(repaired);
        const charData = meta.charData;

        // 기존 캐릭터 참고로 만든 결과에 섹션 헤더가 없으면 자유 입력처럼 한 덩어리로
        const singleBlock = meta.isSheetMode || (meta.isMirror && countMainSections(text) === 0);

        state.currentGeneration = {
            mode: meta.mode,
            sections: singleBlock ? { _custom: { header: '', content: text } } : parseResponse(text),
            fullText: text,
            isCustomSheet: singleBlock,
            sheetTemplate: meta.sheetTemplate,
            conceptText: meta.conceptText,
            charName: meta.worldOnly ? (guessWorldName(text) || worldFallbackName(text))
                : isBot ? (guessProfileName(text) || '새 캐릭터') : (meta.noTarget ? '월드인포만 참고' : getTargetDisplayName(charData)),
            worldOnly: !!meta.worldOnly,
            noTarget: meta.noTarget,
            wiNames: meta.wiNames,
            refName: isBot && charData && !charData.isManual ? getCharName(charData) : '',
            charAvatar: charData && !charData.isManual ? getCharacterKey(charData) : '',
            manualCharacter: charData?.isManual
                ? { name: getCharName(charData), description: charData.data.description }
                : null,
            direction: meta.direction,
            personaId: meta.personaId,
            greeting: null,
            greetings: [],
            templateId: meta.worldOnly ? 'world' : settings.templatePreset,
            language: meta.language,
            resultKind: 'original',
            timestamp: Date.now(),
            incomplete: checkCompleteness({ kind: 'generate', truncated, expected: meta.expectedSections, text }),
        };

        log(`${isBot ? 'Bot character' : 'Persona'} generated successfully`);
        return state.currentGeneration;

    } finally {
        endOperation(op);
    }
}

export async function regenerateSection(sectionKey, instruction = '') {
    const target = resolveGenerationCharacter().charData;
    if (target) await ensureFullCharacter(target);
    const { messages, meta } = buildRegenRequest(sectionKey, instruction);
    const op = beginOperation();

    try {
        log(`Regenerating section: ${sectionKey} (${meta.sectionTitle})`);

        const { text, truncated } = await requestText(op, messages, `섹션 재생성 — ${meta.sectionTitle}`);

        // 헤더를 빠뜨린 응답이면 원래 헤더를 붙여 섹션 구분이 깨지지 않게 함
        const content = isHeaderLine(text.split('\n')[0]) ? text : `${meta.section.header}\n${text}`;
        state.currentGeneration.sections[sectionKey] = {
            header: content.split('\n')[0].trim(),
            content,
        };
        rebuildFullText();
        markModified();
        refreshBotName(state.currentGeneration);

        return { generation: state.currentGeneration, truncated };

    } finally {
        endOperation(op);
    }
}

export async function regenerateAll(additionalInstructions = '') {
    const previous = state.currentGeneration;
    const config = {
        mode: modeOf(previous),
        conceptText: previous?.conceptText || '',
        additionalInstructions,
    };
    if (previous?.isCustomSheet && previous?.sheetTemplate) {
        config.sheetTemplate = previous.sheetTemplate;
    }
    return await generatePersona(config);
}

export async function translateProfile(targetLang) {
    const gen = state.currentGeneration;
    if (!gen?.fullText) throw new Error('번역할 프로필이 없습니다.');
    if ((gen.language || 'en') === targetLang) throw new Error('원본 언어와 동일한 언어입니다.');

    const { messages } = buildTranslateRequest(targetLang);
    const op = beginOperation();

    try {
        log(`Translating profile: ${gen.language} → ${targetLang}`);

        const source = gen.fullText;
        const received = await requestText(op, messages, '번역');
        const truncated = received.truncated;
        const text = keepsOwnTitle(gen) ? received.text : tidyTitleLines(received.text);

        gen.sections = gen.isCustomSheet ? { _custom: { header: '', content: text } } : parseResponse(text);
        gen.fullText = text;
        gen.language = targetLang;
        gen.resultKind = 'translation';
        refreshBotName(gen);
        gen.incomplete = checkCompleteness({
            kind: 'translate', truncated, text,
            expected: gen.isCustomSheet ? 0 : countMainSections(source),
        });

        return gen;

    } finally {
        endOperation(op);
    }
}

export async function modifyProfile(instruction) {
    if (!instruction.trim()) throw new Error('수정 지시사항을 입력해 주십시오.');
    const target = resolveGenerationCharacter().charData;
    if (target) await ensureFullCharacter(target);
    const { messages } = buildModifyRequest(instruction);
    const gen = state.currentGeneration;
    const expected = gen.isCustomSheet ? 0 : countMainSections(gen.fullText);
    const op = beginOperation();

    try {
        log(`Modifying profile: ${instruction.substring(0, 50)}...`);

        const received = await requestText(op, messages, '전체 수정');
        const truncated = received.truncated;
        const text = keepsOwnTitle(gen) ? received.text : tidyTitleLines(received.text);

        gen.sections = gen.isCustomSheet ? { _custom: { header: '', content: text } } : parseResponse(text);
        gen.fullText = text;
        gen.resultKind = 'modified';
        refreshBotName(gen);
        gen.incomplete = checkCompleteness({ kind: 'modify', truncated, expected, text });

        return gen;

    } finally {
        endOperation(op);
    }
}

export async function generateGreeting(options = {}) {
    const gen = state.currentGeneration;
    if (modeOf(gen) !== 'bot') throw new Error('그리팅은 봇 캐릭터 결과에서만 만들 수 있습니다.');
    const target = resolveGenerationCharacter().charData;
    if (target) await ensureFullCharacter(target);
    const { messages, meta } = buildGreetingRequest(options);
    const op = beginOperation();

    try {
        log(`Writing greeting (${meta.length}, ${meta.pov}, ${meta.language})`);
        const { text, truncated } = await requestText(op, messages, '그리팅');
        return addGreetingVersion(gen, {
            text, language: meta.language, length: meta.length, customLength: meta.customLength,
            pov: meta.pov, concept: meta.concept, truncated,
        });
    } finally {
        endOperation(op);
    }
}

// 그리팅 버전들 — 새로 만들거나 고칠 때마다 쌓이고, gen.greeting은 지금 보고 있는 버전
function greetingList(gen) {
    if (!Array.isArray(gen.greetings)) gen.greetings = gen.greeting?.text ? [gen.greeting] : [];
    return gen.greetings;
}

function addGreetingVersion(gen, greeting) {
    greetingList(gen).push(greeting);
    gen.greeting = greeting;
    return greeting;
}

export function greetingTexts(gen) {
    return gen ? greetingList(gen).map(greeting => greeting.text).filter(Boolean) : [];
}

export function greetingPosition() {
    const gen = state.currentGeneration;
    const list = gen ? greetingList(gen) : [];
    return { index: Math.max(0, list.indexOf(gen?.greeting)), total: list.length };
}

export function selectGreeting(step) {
    const gen = state.currentGeneration;
    if (!gen) return null;
    const list = greetingList(gen);
    const next = list[list.indexOf(gen.greeting) + step];
    if (!next) return null;
    gen.greeting = next;
    return next;
}

// 지금 보고 있는 그리팅을 번역해 새 버전으로 추가 (원문 버전은 그대로 남음)
export async function translateGreeting(targetLang) {
    const gen = state.currentGeneration;
    if (modeOf(gen) !== 'bot' || !gen.greeting?.text) throw new Error('번역할 그리팅이 없습니다.');
    const sourceLang = gen.greeting.language || gen.language || 'en';
    if (sourceLang === targetLang) throw new Error('지금 그리팅과 같은 언어입니다.');
    const op = beginOperation();
    try {
        log(`Translating greeting: ${sourceLang} → ${targetLang}`);
        const { text, truncated } = await requestText(op, buildGreetingTranslateRequest(sourceLang, targetLang), '그리팅 번역');
        return addGreetingVersion(gen, { ...gen.greeting, text, language: targetLang, truncated });
    } finally {
        endOperation(op);
    }
}

// 직접 편집은 지금 버전을 고치고, 비우면 그 버전만 지움
export function setGreetingText(text) {
    const gen = state.currentGeneration;
    if (!gen) return;
    const list = greetingList(gen);
    const index = list.indexOf(gen.greeting);
    const value = String(text || '').trim();
    if (value) {
        const next = { ...(gen.greeting || {}), text: value, truncated: false };
        if (index >= 0) list[index] = next;
        else list.push(next);
        gen.greeting = next;
        return;
    }
    if (index >= 0) list.splice(index, 1);
    gen.greeting = list[Math.min(Math.max(index, 0), list.length - 1)] || null;
}

export async function modifyGreeting(instruction) {
    if (!String(instruction || '').trim()) throw new Error('수정 지시사항을 입력해 주십시오.');
    const gen = state.currentGeneration;
    if (modeOf(gen) !== 'bot' || !gen.greeting?.text) throw new Error('수정할 그리팅이 없습니다.');
    const target = resolveGenerationCharacter().charData;
    if (target) await ensureFullCharacter(target);
    const { messages } = buildGreetingModifyRequest(instruction);
    const op = beginOperation();

    try {
        log(`Modifying greeting: ${instruction.substring(0, 50)}...`);
        const { text, truncated } = await requestText(op, messages, '그리팅 수정');
        // 수정본은 새 버전으로 쌓음 (고치기 전 버전으로 되돌아갈 수 있게)
        return addGreetingVersion(gen, { ...gen.greeting, text, truncated });
    } finally {
        endOperation(op);
    }
}
