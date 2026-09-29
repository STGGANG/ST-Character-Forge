import { getContext } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import {
    extensionName, extensionFolderPath,
    PROFILE_FIELDS, TEMPLATE_PRESETS, LANGUAGES, CARD_FIELDS, HISTORY_FILE_NAME, RESETTABLE_SETTING_KEYS,
    BOT_DIRECTIONS, GREETING_LENGTHS, GREETING_POVS, MIRROR_TEMPLATE, FORGE_RANKS, DENSITY_LEVELS, SETTING_FIELDS, MANUAL_PERSONA_ID,
    SUPPORTER_AVATARS, SUPPORTER_FACES, HISTORY_LIMIT, HISTORY_WARN_AT, EXTENSION_VERSION, FONT_SCALES,
} from './constants.js';
import { PROMPT_SLOTS } from './prompt-defaults.js';
import { state, log, logError, getSettings, cancelOperation, isCancelError, onBusyChange } from './state.js';
import {
    updateSetting, saveSettings, getPrompt, isPromptCustomized, setCustomPrompt, resetPrompt,
    resetSettingValues, resetAllSettings, exportSettingsSnapshot, importSettingsSnapshot,
} from './storage.js';
import {
    listHistory, addHistory, updateHistory, duplicateHistory, deleteHistory, deleteHistoryItems, clearHistory, importHistory, getHistoryBackend,
    takeEvictedCount, loadSupportChat, saveSupportChat, exportHistoryItems,
} from './history-store.js';
import { getConnectionProfiles, describeConnection, testConnection } from './api.js';
import {
    WI_SOURCES, MANUAL_CHARACTER_KEY, NO_CHARACTER_KEY, getCharacterKey, readCharacterWorldInfo, loadBookEntries,
    storeBookSelected, storeEntrySelected, getSelectedEntries,
} from './worldinfo.js';
import {
    generatePersona, regenerateSection, regenerateAll, translateProfile, updateFromEditedText, modifyProfile, markModified,
    buildPreview, describeStructure, isCardFieldEnabled, ensureFullCharacter,
    makeManualCharacter, headerLabel, getCardFieldTexts, tidyTitleLines, keepsOwnTitle,
    guessIconForHeader, parseResponse, rebuildFullText, getSectionBody, setSectionBody,
    isBotMode, listPersonas, selectedPersonaId, getEffectiveField, getEffectiveSettingField, generateGreeting, setGreetingText, selectGreeting, translateGreeting, greetingPosition, greetingTexts, guessProfileName, countMainSections,
    modifyGreeting, sendSupportMessage, describeSupportMaterial, supporterName, applySupportEdit, canUndoSupportEdit, undoSupportEdit,
} from './generator.js';

let isEditMode = false;

let wiRevision = 0; // 캐릭터를 빠르게 바꿀 때 늦게 도착한 목록을 버리기 위한 번호
let wiCharKey = '';
let wiShowOtherBooks = false;
const wiExpandedBooks = new Set();
const wiCollapsedBooks = new Set();

const LOADING_TEXTS = {
    persona: [
        '페르소나를 대장간에서 벼려내는 중...',
        '성격을 틀에 붓고 단단히 굳히는 중...',
        '개성을 불꽃 속에서 단련하는 중...',
        '설정 충돌을 용광로에 던지는 중...',
        '숨은 모순 하나를 몰래 새겨 넣는 중...',
    ],
    world: [
        '세계의 뼈대를 모루 위에 올리는 중...',
        '대륙과 도시를 한 덩이씩 두드리는 중...',
        '세력 다툼을 용광로에 던지는 중...',
        '오래된 전설에 불씨를 붙이는 중...',
    ],
    bot: [
        '캐릭터를 대장간에서 벼려내는 중...',
        '성격을 틀에 붓고 단단히 굳히는 중...',
        '개성을 불꽃 속에서 단련하는 중...',
        '설정 충돌을 용광로에 던지는 중...',
        '그 인물만의 비밀을 한 겹 덧씌우는 중...',
    ],
    modify: [
        '프로필을 모루 위에서 다듬는 중...',
        '고칠 곳을 다시 달궈 두드리는 중...',
        '이음새를 매끄럽게 펴는 중...',
    ],
    translate: [
        '다른 언어의 주형에 부어넣는 중...',
        '낯선 글자로 한 자 한 자 새기는 중...',
        '말투가 식지 않게 옮겨 담는 중...',
    ],
    section: [
        '이 부분만 다시 달구는 중...',
        '같은 자리를 한 번 더 두드리는 중...',
    ],
    greeting: [
        '첫 장면의 막을 올리는 중...',
        '첫 대사를 숫돌에 가는 중...',
        '무대에 조명을 켜는 중...',
    ],
    greetingModify: [
        '첫 장면을 다시 두드리는 중...',
        '대사의 날을 다시 세우는 중...',
    ],
    greetingTranslate: [
        '첫 장면을 다른 말로 옮기는 중...',
        '대사의 결을 살려 옮기는 중...',
    ],
};
const LONG_WAIT_TEXTS = [
    [60, '불이 좀 셉니다. 조금만 더...'],
    [180, '명검은 원래 오래 걸리는 법입니다.'],
    [420, '대장장이가 유난히 공들이는 중입니다.'],
];
const DONE_TEXTS = {
    persona: ['페르소나가 완성되었습니다!', '갓 벼려낸 페르소나가 나왔습니다!', '따끈한 페르소나가 모루에서 내려왔습니다!'],
    bot: ['봇 캐릭터가 완성되었습니다!', '갓 벼려낸 캐릭터가 나왔습니다!', '따끈한 캐릭터가 모루에서 내려왔습니다!'],
    world: ['세계관이 완성되었습니다!', '갓 벼려낸 세계가 나왔습니다!', '따끈한 세계가 모루에서 내려왔습니다!'],
    greeting: ['그리팅을 만들었습니다!', '첫 장면의 막이 올랐습니다!', '첫 장면이 준비되었습니다!'],
};
let loadingTextTimer = null;
let hammerTaps = 0;

const modeSelections = { persona: null, bot: null };

const FONT_URL = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';

// 글꼴은 따로 불러옴 — style.css 안에서 @import하면 CDN이 느리거나 막혔을 때 확장 스타일 전체가 늦게 적용됨
function loadFont() {
    if (document.querySelector(`link[href="${FONT_URL}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONT_URL;
    document.head.appendChild(link);
}

export async function loadPopupHtml() {
    loadFont();
    try {
        const html = await $.get(`${extensionFolderPath}/popup.html`);
        $('body').append(html);
        log('Popup HTML loaded');
        return true;
    } catch (error) {
        logError('loadPopupHtml', error);
        return false;
    }
}

export function addExtensionMenuButton() {
    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
        setTimeout(addExtensionMenuButton, 1000);
        return;
    }

    if (document.getElementById('pf-menu-btn')) return;

    const menuItem = document.createElement('div');
    menuItem.id = 'pf-menu-btn';
    menuItem.className = 'list-group-item flex-container flexGap5 interactable';
    menuItem.innerHTML = `
        <div class="fa-solid fa-hammer extensionsMenuExtensionButton"></div>
        캐릭터 대장간
    `;
    menuItem.addEventListener('click', () => {
        openPopup();
        $('#extensionsMenu').hide();
    });
    extensionsMenu.appendChild(menuItem);
    log('Extension menu button added');
}

// 한글·일본어 등 입력기로 글자를 조합하는 중인지 (jQuery 이벤트에는 isComposing이 없어 원래 이벤트에서 읽음)
function isImeComposing(e) {
    return !!(e.originalEvent?.isComposing || e.isComposing || e.keyCode === 229);
}

// ===== 설치·업데이트 후 한 번 뜨는 안내 창 =====
const UPDATE_NOTES = [
    '대장간 창과 모루 남매 대화의 글자 크기를 따로 조절하고, 글꼴도 고를 수 있습니다. (설정 탭 → 화면)',
    '모루 남매에게 작가 정보(성별 · 자기소개)를 알려 줄 수 있습니다.',
    '모루 남매와의 대화를 기록마다 따로 저장해, 대화가 길어져도 저장이 가볍습니다.',
    '기록 보관 개수가 200개로 늘었고, 가득 차기 전에 미리 알려 줍니다.',
    '프롬프트 탭의 항목 이름을 [페르소나] · [봇] · [공통]처럼 보기 쉽게 정리했습니다.',
    '직접 편집 · 섹션 재생성 · 바로 적용한 내용이 기록에 저장되지 않던 문제를 고쳤습니다.',
];

// 쌍둥이 기본 이미지 (직접 올린 이미지가 있으면 그것)
function noticeAvatarHtml(gender, face) {
    const custom = getSettings()?.supporterAvatars?.[gender] || {};
    const url = custom[face] || custom.neutral || SUPPORTER_AVATARS[gender]?.[face] || SUPPORTER_AVATARS[gender]?.neutral;
    return url ? `<img src="${escapeHtml(url)}" alt="">` : '<i class="fa-solid fa-hammer"></i>';
}

// 대장간 창을 열 때 — 이 버전의 안내에서 "확인"을 누른 적이 없으면 띄움
// (확인을 눌러야만 본 것으로 기록 → 안 누르고 새로고침하면 다음에 열 때 다시)
// force: ⋮ 메뉴의 "업데이트 내역"으로 다시 볼 때 (이미 확인했어도 띄움)
function showUpdateNoticeOnce({ force = false } = {}) {
    const settings = getSettings();
    if (!settings || $('.pf-update-notice').length) return;
    if (!force && settings.lastSeenVersion === EXTENSION_VERSION) return;
    const line = (gender, face, text) => `
        <div class="pf-support-msg pf-support-theirs">
            <span class="pf-support-avatar pf-support-avatar-chat" aria-hidden="true">${noticeAvatarHtml(gender, face)}</span>
            <div class="pf-support-stack">
                <span class="pf-support-name">${escapeHtml(supporterName(gender))}</span>
                <div class="pf-support-group"><div class="pf-support-bubble">${escapeHtml(text)}</div></div>
            </div>
        </div>`;
    const $notice = $(`
        <div class="persona-forge-popup open pf-update-notice" role="dialog" aria-modal="true" aria-label="캐릭터 대장간 업데이트 안내">
            <div class="pf-update-card">
                <div class="pf-update-head">
                    <h2 class="pf-update-title">캐릭터 대장간</h2>
                    <span class="pf-update-version">v${EXTENSION_VERSION}</span>
                </div>
                ${line('female', 'smile', '업데이트 끝났어요. 글자가 작아서 눈 찡그리던 분들, 이제 설정 탭 맨 아래에서 키울 수 있어요.')}
                ${line('male', 'smile', '그리고 이제 저희랑 대화할 때 작가님 소개도 받을 수 있어요. 궁금했거든요, 작가님이 어떤 분인지!')}
                <div class="pf-update-notes">
                    <h3>${EXTENSION_VERSION} — 업데이트 내역</h3>
                    <ul>${UPDATE_NOTES.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>
                </div>
                <button type="button" class="pf-primary-btn pf-update-ok">확인</button>
            </div>
        </div>`);
    $notice.on('click', '.pf-update-ok', () => {
        updateSetting('lastSeenVersion', EXTENSION_VERSION);
        $notice.remove();
    });
    if (settings.uiFontFamily === 'theme') $notice[0].style.setProperty('--pf-font', THEME_FONT);
    $('body').append($notice);
}

export function bindUIEvents() {
    // 이벤트는 팝업 안에서만 처리 (실리태번의 다른 곳을 누를 때 검사하지 않도록)
    const $root = $('#persona-forge-popup');

    $root.on('click', '#pf-close-btn', closePopup);
    $root.on('click', '#pf-title-hammer', onTitleHammerClick);

    // 바깥 배경을 눌렀을 때만 닫기 (안쪽에서 글자를 드래그하다 바깥에서 놓은 경우는 제외)
    let pressedBackdrop = false;
    $root.on('pointerdown', (e) => { pressedBackdrop = e.target === $root[0]; });
    $root.on('click', (e) => {
        if (e.target === $root[0] && pressedBackdrop) closePopup();
    });

    // ESC로 닫기 (실리태번 대화상자가 위에 떠 있을 때는 그 대화상자만 닫히도록 무시)
    $(document).on('keydown', (e) => {
        if (e.key !== 'Escape' || !$('#persona-forge-popup').hasClass('open')) return;
        if (document.querySelector('dialog[open]')) return;
        closePopup();
    });

    $root.on('click', '.pf-tab', function () {
        const tab = $(this).data('tab');
        switchTab(tab);
    });

    onBusyChange(updateBusyIndicator);
    $root.on('click', '#pf-busy-banner', () => switchTab('generate'));

    $root.on('click', '.pf-mode-control button', function () {
        switchForgeMode(String($(this).attr('data-forge-mode')));
    });

    $root.on('change', 'input[name="pf-bot-direction"]', function () {
        updateSetting('botDirection', $(this).val());
    });
    $root.on('change', '#pf-bot-persona', function () {
        updateSetting(personaSettingKey(), String($(this).val() || ''));
        updateBotPersonaInfo();
    });
    $root.on('input', '#pf-persona-manual-name, #pf-persona-manual-desc', function () {
        updateSetting('manualPersona', {
            name: String($('#pf-persona-manual-name').val() || ''),
            description: String($('#pf-persona-manual-desc').val() || ''),
        });
        updateBotPersonaInfoSoon();
    });

    $root.on('change', '#pf-char-select', onCharacterSelect);
    $root.on('input', '#pf-char-search', debounce(onCharacterSearchInput, 120));
    $root.on('click', '.pf-char-result', function () { pickCharacter(Number($(this).attr('data-index'))); });
    $root.on('click', '.pf-char-result-more', () => {
        charResultsShown += CHAR_RESULTS_STEP;
        renderCharacterResults();
    });
    $root.on('keydown', '#pf-char-search', (e) => {
        if (e.key !== 'Enter' || isImeComposing(e)) return;
        e.preventDefault();
        onCharacterSearchEnter();
    });

    $root.on('click', '#pf-card-fields-toggle', () => {
        const $list = $('#pf-card-fields-list');
        $list.toggle();
        $('#pf-card-fields-toggle i').attr('class', `fa-solid fa-chevron-${$list.is(':visible') ? 'up' : 'down'}`);
    });
    $root.on('change', '.pf-card-field-cb', function () {
        const settings = getSettings();
        settings.cardFields ||= {};
        settings.cardFields[$(this).attr('data-field')] = $(this).prop('checked');
        saveSettings();
        renderCardFields();
    });

    $root.on('input', '#pf-manual-name, #pf-manual-desc', onManualInput);

    $root.on('change', '#pf-spoiler-toggle', function () {
        const enabled = $(this).prop('checked');
        updateSetting('spoilerProtection', enabled);
        $('#pf-spoiler-note').toggle(enabled);
    });

    $root.on('change', '#pf-stream-toggle', function () {
        updateSetting('streamRequests', $(this).prop('checked'));
    });

    $root.on('change', '#pf-setting-toggle', function () {
        updateSetting('includeSetting', $(this).prop('checked'));
        updateTemplateDisplay();
    });
    $root.on('change', '#pf-character-toggle', function () {
        updateSetting('includeCharacter', $(this).prop('checked'));
        updateTemplateDisplay();
    });

    $root.on('change', '#pf-density', function () {
        updateSetting('density', String($(this).val()));
        updateDensityDesc();
    });

    $root.on('click', '#pf-more-btn', (e) => {
        e.stopPropagation();
        $('.pf-info[open]').removeAttr('open');
        toggleMoreMenu();
    });
    $root.on('click', '.pf-more-item', onMoreMenuAction);

    // 툴팁(ⓘ)은 하나만 열리게
    // 직접 열고 닫아서, 그려지기 전에 창 안쪽으로 위치를 맞춤 (열린 뒤 옮기면 한 번 튀어 보임)
    $root.on('click', '.pf-info > summary', function (e) {
        e.preventDefault();
        const info = this.parentElement;
        const willOpen = !info.open;
        $('.pf-info[open]').not(info).removeAttr('open');
        info.open = willOpen;
        if (willOpen) positionInfoBubble(info);
    });

    $root.on('click', (e) => {
        if (!$(e.target).closest('.pf-more-wrap').length) closeMoreMenu();
        if (!$(e.target).closest('.pf-info').length) $('.pf-info[open]').removeAttr('open');
    });

    $root.on('change', '#pf-wi-toggle', onWorldInfoToggle);

    $root.on('input', '#pf-wi-search', debounce(renderWIBooks, 150));
    $root.on('click', '#pf-wi-reload', () => refreshWorldInfo());

    $root.on('change', '.pf-wi-book-cb', onWIBookToggle);
    $root.on('click', '.pf-wi-book-expand', onWIBookExpandToggle);
    $root.on('click', '.pf-wi-bulk-btn', onWIBulkSelect);
    $root.on('click', '#pf-wi-other-toggle', () => {
        wiShowOtherBooks = !wiShowOtherBooks;
        renderWIBooks();
    });

    $root.on('change', '.pf-wi-entry-cb', onWIEntryToggle);

    $root.on('change', 'input[name="pf-gen-mode"]', onModeChange);

    $root.on('change', '#pf-api-profile', function () {
        updateSetting('connectionProfile', $(this).val());
        updateMaxTokensHint();
        $('#pf-conn-status').hide();
    });
    $root.on('click', '#pf-conn-test', () => onConnectionTest('main'));
    // 글자 크기 (화면)
    $root.on('change', 'input[name="pf-ui-font"]', function () {
        updateSetting('uiFontSize', FONT_SCALES[$(this).val()] ? $(this).val() : 'medium');
        applyFontScale();
    });
    $root.on('change', 'input[name="pf-chat-font"]', function () {
        updateSetting('chatFontSize', FONT_SCALES[$(this).val()] ? $(this).val() : 'medium');
        applyFontScale();
    });
    $root.on('change', 'input[name="pf-ui-font-family"]', function () {
        updateSetting('uiFontFamily', $(this).val() === 'theme' ? 'theme' : 'pretendard');
        applyFontScale();
    });
    $root.on('click', '#pf-supporter-conn-test', () => onConnectionTest('supporter'));
    $root.on('change', '#pf-supporter-profile', function () {
        updateSetting('supporterProfile', String($(this).val() || ''));
        $('#pf-supporter-conn-status').hide();
    });

    // 대화형 서포터
    $root.on('click', '#pf-support-toggle, .pf-support-chevron-btn', toggleSupport);
    $(window).on('resize', debounce(fitSupportLogHeight, 200));
    // 모바일에서는 입력칸 안내를 짧게 (두 줄로 넘어가지 않게)
    const narrowScreen = window.matchMedia?.('(max-width: 600px)');
    const setSupportPlaceholder = () => $('#pf-support-text').attr('placeholder', narrowScreen?.matches
        ? '메시지 입력...'
        : '메시지 입력... (Enter 보내기 · Shift+Enter 줄바꿈)');
    setSupportPlaceholder();
    narrowScreen?.addEventListener?.('change', setSupportPlaceholder);
    // 대화창 위아래 그라데이션 — scroll은 위로 전달되지 않아 대화창에 직접 붙임 (프레임당 한 번만 계산)
    let supportFadeFrame = 0;
    document.getElementById('pf-support-log')?.addEventListener('scroll', () => {
        supportFadeFrame ||= requestAnimationFrame(() => {
            supportFadeFrame = 0;
            updateSupportFade();
        });
    }, { passive: true });
    $root.on('click', '#pf-support-send', onSupportSend);
    // 한글 조합 중에 누른 엔터는 글자 확정용 — 무시해야 마지막 글자가 남거나 두 번 전송되지 않음
    $root.on('keydown', '#pf-support-text', (e) => {
        if (e.key !== 'Enter' || e.shiftKey || isImeComposing(e)) return;
        e.preventDefault();
        if (supportController) return; // 답을 기다리는 동안 엔터로는 취소하지 않음 (취소는 버튼으로)
        onSupportSend();
    });
    $root.on('input', '#pf-support-text', function () { growSupportInput(this); });
    $root.on('click', '#pf-support-settings-btn', () => $('#pf-support-settings').toggle());
    $root.on('input', '#pf-support-username', debounce(function () {
        updateSetting('supporterUserName', String($('#pf-support-username').val() || '').trim());
    }, 300));
    $root.on('change', 'input[name="pf-support-user-gender"]', function () {
        updateSetting('supporterUserGender', ['female', 'male'].includes($(this).val()) ? $(this).val() : '');
    });
    $root.on('input', '#pf-support-userintro', debounce(function () {
        updateSetting('supporterUserIntro', String($('#pf-support-userintro').val() || '').trim());
    }, 300));
    // 성별은 이 대화의 것 (대화마다 따로) — 고른 성별은 새 대화의 기본값도 됨
    $root.on('change', 'input[name="pf-supporter-gender"]', function () {
        const gender = $(this).val() === 'male' ? 'male' : 'female';
        updateSetting('supporterGender', gender);
        const gen = state.currentGeneration;
        if (gen) {
            gen.supportGender = gender;
            saveSupportChatSoon(gen);
        }
        renderSupportIdentity();
        if ($('#pf-support-toggle').attr('aria-expanded') === 'true') renderSupportLog({ scroll: 'stay' });
    });
    $root.on('click', '#pf-support-clear', onSupportClear);
    $root.on('click', '.pf-support-face-pick', function () {
        pendingAvatarFace = String($(this).attr('data-face') || 'neutral');
        $('#pf-support-avatar-file').trigger('click');
    });
    $root.on('change', '#pf-support-avatar-file', onSupportAvatarFile);
    $root.on('click', '.pf-support-face-remove', onSupportAvatarRemove);
    $root.on('click', '.pf-support-apply', onSupportApply);
    $root.on('click', '.pf-support-undo', onSupportUndo);
    $root.on('click', '.pf-support-edit-copy', onSupportEditCopy);
    $root.on('click', '.pf-support-regen', onSupportRegenerate);
    $root.on('click', '.pf-support-more', onSupportMore);
    $root.on('click', '.pf-support-swipe-prev', () => stepSupportSwipe(-1));
    $root.on('click', '.pf-support-swipe-next', () => stepSupportSwipe(1));
    // 모바일: 마지막 답을 좌우로 밀어 다른 버전 보기
    $root.on('touchstart', '.pf-support-swipeable .pf-support-group', (e) => {
        const touch = e.originalEvent.touches?.[0];
        supportTouch = touch ? { x: touch.clientX, y: touch.clientY } : null;
    });
    $root.on('touchend', '.pf-support-swipeable .pf-support-group', (e) => {
        const touch = e.originalEvent.changedTouches?.[0];
        const start = supportTouch;
        supportTouch = null;
        if (!touch || !start) return;
        const dx = touch.clientX - start.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(touch.clientY - start.y) * 1.5) stepSupportSwipe(dx < 0 ? 1 : -1);
    });
    $root.on('click', '.pf-support-delete', onSupportDelete);
    $root.on('click', '.pf-support-copy', onSupportCopy);
    $root.on('click', '.pf-prompt-scope-btn', onPromptScopeChange);

    $root.on('change', '#pf-max-tokens', function () {
        const value = Math.max(0, Math.floor(Number($(this).val()) || 0));
        $(this).val(value);
        updateSetting('maxTokens', value);
        updateMaxTokensHint();
    });

    $root.on('change', '#pf-template-select', onTemplateChange);

    $root.on('change', '#pf-language', function () {
        updateSetting('language', $(this).val());
    });

    $root.on('change', '.pf-custom-field-cb', onCustomFieldToggle);

    $root.on('click', '#pf-generate-btn', onGenerateClick);

    $root.on('click', '#pf-cancel-gen-btn', onCancelGeneration);

    $root.on('click', '#pf-regen-all-btn', () => {
        $('#pf-regen-all-panel').toggle();
        $('#pf-translate-panel').hide();
    });

    $root.on('click', '#pf-regen-all-go', onRegenAllClick);
    $root.on('click', '#pf-regen-all-cancel', () => $('#pf-regen-all-panel').hide());

    $root.on('click', '#pf-edit-toggle-btn', toggleEditMode);

    $root.on('click', '#pf-edit-apply', applyEdit);

    $root.on('click', '#pf-translate-btn', () => {
        $('#pf-translate-panel').toggle();
        $('#pf-regen-all-panel').hide();
    });

    $root.on('click', '#pf-translate-go', onTranslateClick);
    $root.on('click', '#pf-translate-cancel', () => $('#pf-translate-panel').hide());

    $root.on('click', '.pf-section-regen-btn', onSectionRegenToggle);
    $root.on('click', '.pf-section-regen-go', onSectionRegenClick);
    $root.on('click', '.pf-section-regen-cancel', function () {
        $(this).closest('.pf-section-regen-panel').hide();
    });

    $root.on('click', '.pf-section-edit-btn', onSectionEditToggle);
    $root.on('click', '.pf-section-edit-save', onSectionEditSave);
    $root.on('click', '.pf-section-edit-cancel', onSectionEditCancel);

    $root.on('change', '#pf-autosave-toggle', onAutoSaveToggle);
    $root.on('change', '#pf-sound-toggle', function () {
        updateSetting('completionSound', $(this).prop('checked'));
        if ($(this).prop('checked')) {
            primeAudio();
            playChime('done');
        }
    });
    // 브라우저는 사용자 동작 없이 소리를 막으므로, 팝업을 누를 때 소리 장치를 미리 깨워 둠
    $root.on('pointerdown', primeAudio);

    $root.on('click', '#pf-copy-btn', onCopyClick);

    $root.on('click', '#pf-apply-persona-btn', onApplyPersonaClick);

    $root.on('click', '#pf-save-history-btn', onSaveHistoryClick);

    // 기록 항목을 누르면 불러오기 (오른쪽 버튼들은 제외)
    $root.on('click', '.pf-history-item.pf-loadable', function (e) {
        if ($(e.target).closest('.pf-history-actions').length) return;
        onHistoryLoad.call(this);
    });
    $root.on('keydown', '.pf-history-item.pf-loadable', function (e) {
        if (e.key !== 'Enter' || $(e.target).closest('.pf-history-actions').length) return;
        e.preventDefault();
        onHistoryLoad.call(this);
    });
    $root.on('click', '#pf-history-add', () => {
        const $panel = $('#pf-history-add-panel');
        if ($panel.is(':visible')) return $panel.hide();
        $('#pf-history-add-mode').val(isBotMode() ? 'bot' : 'persona');
        $('#pf-history-add-lang').val(getSettings().language || 'en');
        $panel.show();
        $('#pf-history-add-text').trigger('focus');
    });
    $root.on('click', '#pf-history-add-cancel', () => $('#pf-history-add-panel').hide());
    $root.on('click', '#pf-history-add-save', onHistoryAddSave);
    $root.on('click', '.pf-history-copy', onHistoryCopy);
    $root.on('click', '.pf-history-duplicate', onHistoryDuplicate);
    $root.on('click', '.pf-history-fav', onHistoryFavorite);
    $root.on('click', '#pf-history-prev', () => changeHistoryPage(-1));
    $root.on('click', '#pf-history-next', () => changeHistoryPage(1));
    $root.on('click', '.pf-history-delete', onHistoryDelete);
    $root.on('click', '#pf-history-clear', onHistoryClear);

    $root.on('input', '#pf-history-search', debounce(onHistoryFilterChange, 200));
    $root.on('change', '#pf-history-filter-lang', onHistoryFilterChange);
    $root.on('change', '#pf-history-filter-mode', onHistoryFilterChange);
    $root.on('change', '#pf-history-filter-template', onHistoryFilterChange);

    $root.on('click', '#pf-history-select-toggle', () => setHistorySelectMode(true));
    $root.on('click', '#pf-history-select-cancel', () => setHistorySelectMode(false));
    $root.on('click', '#pf-history-select-all', onHistorySelectAll);
    $root.on('click', '#pf-history-delete-selected', onHistoryDeleteSelected);
    $root.on('click', '.pf-history-item.pf-selectable', function (e) {
        if ($(e.target).closest('.pf-history-check-wrap').length) return;
        const $check = $(this).find('.pf-history-check');
        $check.prop('checked', !$check.prop('checked')).trigger('change');
    });
    $root.on('change', '.pf-history-check', function () {
        const id = String($(this).attr('data-id'));
        if ($(this).prop('checked')) historySelected.add(id);
        else historySelected.delete(id);
        $(this).closest('.pf-history-item').toggleClass('pf-selected', $(this).prop('checked'));
        updateHistorySelectionControls();
    });

    $root.on('click', '#pf-greeting-toggle-btn', openGreetingPanel);
    $root.on('click', '#pf-greeting-cancel', () => $('#pf-greeting-panel').hide());
    $root.on('change', 'input[name="pf-greeting-length"]', function () {
        updateSetting('greetingLength', $(this).val());
        updateGreetingLengthInput();
    });
    $root.on('input', '#pf-greeting-length-custom', function () {
        updateSetting('greetingLengthCustom', String($(this).val() || ''));
    });
    $root.on('change', 'input[name="pf-greeting-pov"]', function () {
        updateSetting('greetingPov', $(this).val());
    });
    $root.on('click', '#pf-greeting-go', onGreetingGenerate);
    $root.on('click', '#pf-greeting-stop', onGreetingStop);
    $root.on('click', '#pf-greeting-edit', onGreetingEditToggle);
    $root.on('click', '#pf-greeting-edit-save', onGreetingEditSave);
    $root.on('click', '#pf-greeting-edit-cancel', () => {
        $('#pf-greeting-edit-panel').hide();
        $('#pf-greeting-body').show();
    });
    $root.on('click', '#pf-greeting-copy', onGreetingCopy);
    $root.on('click', '#pf-greeting-modify-toggle-btn', () => {
        $('#pf-greeting-panel, #pf-greeting-translate-panel').hide();
        $('#pf-greeting-modify-panel').toggle();
    });
    $root.on('click', '#pf-greeting-modify-cancel', () => $('#pf-greeting-modify-panel').hide());
    $root.on('click', '#pf-greeting-modify-go', onGreetingModify);
    $root.on('click', '#pf-greeting-delete', onGreetingDelete);
    $root.on('click', '#pf-greeting-translate-btn', openGreetingTranslatePanel);
    $root.on('click', '#pf-greeting-translate-cancel', () => $('#pf-greeting-translate-panel').hide());
    $root.on('click', '#pf-greeting-translate-go', onGreetingTranslate);
    $root.on('click', '#pf-greeting-prev', () => onGreetingSwipe(-1));
    $root.on('click', '#pf-greeting-next', () => onGreetingSwipe(1));

    $root.on('click', '#pf-create-card-btn', onCreateCardClick);

    $root.on('click', '#pf-modify-toggle-btn', () => {
        $('#pf-modify-panel').toggle();
    });
    $root.on('click', '#pf-modify-go', onModifyClick);
    $root.on('click', '#pf-modify-cancel', () => $('#pf-modify-panel').hide());

    $root.on('input', '#pf-sheet-text', function () {
        updateSetting('sheetTemplate', $(this).val());
    });

    $root.on('change', '#pf-prompt-slot', onPromptSlotChange);
    $root.on('input', '#pf-prompt-editor', updatePromptStatus);
    $root.on('click', '#pf-prompt-reset', onPromptReset);
    $root.on('click', '#pf-prompt-apply', onPromptApply);
    $root.on('click', '#pf-prompt-preset-save', onPromptPresetSave);
    $root.on('click', '#pf-prompt-preset-load', onPromptPresetLoad);
    $root.on('click', '#pf-prompt-preset-delete', onPromptPresetDelete);
    $root.on('click', '#pf-preview-btn', onPreviewClick);
    $root.on('click', '#pf-preview-close', () => {
        previewItems = [];
        $('#pf-preview-output').empty();
        $('#pf-preview-close').hide();
    });
    $root.on('click', '.pf-preview-copy', onPreviewCopy);
    $root.on('change', '#pf-legacy-select', renderLegacyText);
    $root.on('click', '#pf-legacy-copy', onLegacyCopy);
    $root.on('click', '#pf-legacy-delete', onLegacyDelete);
    $root.on('change', '#pf-structure-kind', renderStructure);
    $root.on('click', '#pf-structure > summary', () => setTimeout(renderStructure, 0));

    $root.on('click', '.pf-field-add', onCustomFieldAdd);
    $root.on('click', '.pf-field-all', function () {
        // 이미 고른 항목의 순서는 유지하고 나머지를 목록 순서대로 뒤에 추가
        const set = fieldSetOf(this);
        const all = getAllFieldIds(set);
        const current = selectedFieldIds(set);
        updateSetting(FIELD_SETS[set].selectedKey, [...current, ...all.filter(id => !current.includes(id))]);
        FIELD_SETS[set].refresh();
    });
    $root.on('click', '.pf-field-none', function () {
        const set = fieldSetOf(this);
        updateSetting(FIELD_SETS[set].selectedKey, []);
        FIELD_SETS[set].refresh();
    });
    $root.on('click', '.pf-field-reset', onCustomFieldReset);
    $root.on('click', '.pf-field-edit-btn', onFieldEditToggle);
    $root.on('input', '.pf-autogrow', function () { autoGrow(this); });
    $root.on('input', '.pf-section-edit-textarea', function () { fitToContent(this); });
    $root.on('keydown', '.pf-autogrow', (e) => { if (e.key === 'Enter' && !isImeComposing(e)) e.preventDefault(); });
    $root.on('click', '.pf-field-delete-btn', onFieldDelete);
    $root.on('click', '.pf-field-edit-save', onFieldEditSave);
    $root.on('click', '.pf-field-edit-cancel', onFieldEditCancel);
    $root.on('click', '.pf-field-move-btn', onFieldMove);

    log('UI events bound');
}

function positionInfoBubble(info) {
    if (!info?.open) return;
    const container = document.querySelector('#persona-forge-popup .pf-container');
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const margin = 12;
    for (const bubble of info.querySelectorAll('.pf-info-bubble')) {
        bubble.style.left = '';
        bubble.style.maxWidth = `${Math.min(340, Math.max(160, bounds.width - margin * 2))}px`;
        const rect = bubble.getBoundingClientRect();
        if (!rect.width) continue; // 지금 모드에서 숨은 말풍선
        const baseLeft = parseFloat(getComputedStyle(bubble).left) || 0;
        let shift = 0;
        if (rect.right > bounds.right - margin) shift = (bounds.right - margin) - rect.right;
        if (rect.left + shift < bounds.left + margin) shift = (bounds.left + margin) - rect.left;
        if (shift) bubble.style.left = `${baseLeft + shift}px`;
    }
}

export function openPopup() {
    populateLanguageSelects();
    populateDensitySelect();
    applyForgeModeUI();
    updateSettingsUI();
    populateBotPersonas();
    populateAPIProfiles();
    updateMaxTokensHint();
    populateCharacterDropdown();
    renderCardFields();
    updateHistoryUI();
    promptScope = null;
    updatePromptUI();
    renderSupportIdentity();
    seedForgedCount();
    $('#persona-forge-popup').addClass('open');
    requestAnimationFrame(fitSupportLogHeight); // 창이 보인 뒤에 높이를 잼
    showUpdateNoticeOnce(); // 설치·업데이트 후 확인을 누르기 전까지 (대장간 창 위에)
}

export function closePopup() {
    $('#persona-forge-popup').removeClass('open');
}

// 탭마다 스크롤 위치 기억 (긴 탭에서 내려온 위치가 다른 탭에 남지 않게)
const tabScroll = {};

function switchTab(tabName) {
    const $body = $('.pf-body');
    const previous = $('.pf-tab.active').attr('data-tab');
    if (previous) tabScroll[previous] = $body.scrollTop();
    $('.pf-tab').removeClass('active');
    $(`.pf-tab[data-tab="${tabName}"]`).addClass('active');
    $('.pf-tab-content').removeClass('active');
    $(`#pf-${tabName}-tab`).addClass('active');

    if (tabName === 'history') updateHistoryUI();
    if (tabName === 'prompt') renderStructure();
    updateBusyIndicator();
    $body.scrollTop(previous === tabName ? $body.scrollTop() : (tabScroll[tabName] || 0));
}

function scrollGenerateTabToTop() {
    tabScroll.generate = 0;
    if ($('.pf-tab[data-tab="generate"]').hasClass('active')) $('.pf-body').scrollTop(0);
}

// 생성 중이면 생성 탭에 점, 다른 탭을 보고 있으면 위쪽에 "생성 진행 중" 배너 (누르면 생성 화면으로)
function updateBusyIndicator() {
    const busy = !!state.isGenerating;
    const $generateTab = $('.pf-tab[data-tab="generate"]');
    $generateTab.toggleClass('pf-tab-busy', busy);
    $('#pf-busy-banner').toggle(busy && !$generateTab.hasClass('active'));
    if (!busy) $('#pf-busy-progress').text('');
}

const SETTINGLESS_TEMPLATES = ['mirror', 'custom'];

// 봇 모드에서 캐릭터 프로필을 만드는지 (끄면 세계관만) — 페르소나 모드는 항상 만듦
function characterOn() {
    return !isBotMode() || getSettings()?.includeCharacter !== false;
}

// 세계관 설정 — 켰을 때만 항목 목록(Choice와 같은 방식)을 보여 줌
function renderSettingPanel() {
    const settings = getSettings();
    const withCharacter = characterOn();
    // 기존 캐릭터 참고(Mirror)·자유 입력은 양식이 정해져 있어 세계관을 넣지 않음 (세계관만 만들 때는 상관없음)
    const available = !withCharacter || !SETTINGLESS_TEMPLATES.includes(settings?.templatePreset);
    const on = available && !!settings?.includeSetting;
    // toggle()은 숨은 상태에서 되살릴 때 표시 방식을 바꿀 수 있어 인라인 값만 조절
    $('#pf-setting-row').css('display', available ? '' : 'none');
    $('#pf-setting-row .pf-row-desc').text(withCharacter ? '프로필에 세계관 설정을 포함' : '캐릭터 없이 세계관만 만듭니다');
    $('#pf-template-row').toggleClass('pf-no-divider', !available);
    $('#pf-setting-panel, #pf-setting-tags').css('display', on ? '' : 'none');
    renderFieldTags('setting', '#pf-setting-tags');
    if (on) renderFieldList('setting');
}

function populateDensitySelect() {
    const $select = $('#pf-density');
    if ($select.children().length) return;
    $select.html(Object.entries(DENSITY_LEVELS).map(([key, level]) => `<option value="${key}">${escapeHtml(level.label)}</option>`).join(''));
}

function updateDensityDesc() {
    const level = DENSITY_LEVELS[getSettings()?.density] || DENSITY_LEVELS.default;
    $('#pf-density-desc').text(level.desc);
}

function populateLanguageSelects() {
    const options = Object.entries(LANGUAGES)
        .map(([code, lang]) => `<option value="${code}">${escapeHtml(lang.label)}</option>`).join('');
    $('.pf-language-select').each(function () {
        const value = $(this).val();
        $(this).html(options);
        if (value && LANGUAGES[value]) $(this).val(value);
    });
    const $filter = $('#pf-history-filter-lang');
    const filterValue = $filter.val();
    $filter.html(`<option value="">모든 언어</option>${options}`).val(filterValue || '');
}

function applyForgeModeUI() {
    const bot = isBotMode();
    $('#persona-forge-popup').toggleClass('pf-mode-bot', bot);
    $('.pf-mode-control button').each(function () {
        $(this).attr('aria-pressed', String($(this).attr('data-forge-mode') === (bot ? 'bot' : 'persona')));
    });

    $('#pf-manual-name').attr('placeholder', bot ? '제목 (비워도 됩니다)' : '캐릭터 이름 (비워도 됩니다)');
    $('#pf-manual-desc').attr('placeholder', bot
        ? '참고할 설정을 붙여넣거나 직접 적어 주십시오...\n예: 세계관, 기존 인물 설정, 만들고 싶은 인물에 대한 메모'
        : '기존 캐릭터의 설정을 붙여넣거나 직접 적어 주십시오...\n예: 외모, 성격, 말투, 세계관, {{user}}와의 관계 등');
    $('#pf-concept-text').attr('placeholder', bot
        ? '원하는 캐릭터 컨셉을 입력하십시오...\n예: 몰락한 가문의 마지막 기사, 충성과 복수 사이에서 흔들림\n예: 참고한 캐릭터의 동생으로, 둘이 함께 등장하는 다인봇'
        : '원하는 캐릭터 컨셉을 입력하십시오...\n예: 시골에서 올라온 순진한 대학생, 호기심이 많지만 세상물정을 잘 모르는 성격\n예: 쿨하고 무관심해 보이지만 속은 따뜻한 직장인');
    if (!state.isGenerating) {
        $('#pf-gen-loading-text').text(LOADING_TEXTS[bot ? 'bot' : 'persona'][0]);
    }
}

async function switchForgeMode(mode) {
    const next = mode === 'bot' ? 'bot' : 'persona';
    const current = isBotMode() ? 'bot' : 'persona';
    if (next === current) return true;
    if (isPromptEditorDirty() && !(await askConfirm('프롬프트 탭에 적용하지 않은 변경이 있습니다. 버리고 모드를 바꾸시겠습니까?'))) return false;

    modeSelections[current] = state.selectedCharKey || null;
    updateSetting('forgeMode', next);

    const kept = modeSelections[next];
    state.selectedCharKey = kept || (next === 'bot' ? NO_CHARACTER_KEY : '');
    state.selectedCharData = null;
    state.selectedCharIndex = -1;
    if (state.selectedCharKey === MANUAL_CHARACTER_KEY) selectManualTarget();

    applyForgeModeUI();
    updateSettingsUI();
    populateBotPersonas();
    populateCharacterDropdown();
    renderCardFields();
    updateTemplateDisplay();
    promptScope = null;
    updatePromptUI();
    if (!state.currentGeneration && !state.isGenerating) {
        $('#pf-gen-empty').show();
    }
    return true;
}

async function populateBotPersonas() {
    const $select = $('#pf-bot-persona');
    if (!$select.length) return;
    let currentId = '';
    try {
        const personasModule = await import("../../../../personas.js");
        currentId = String(personasModule?.user_avatar || '');
    } catch { /* 현재 페르소나 표시만 생략 */ }

    // 실리태번 설정에 이름만 남아 있고 아바타 파일은 지워진 페르소나는 빼고 보여줌
    const existing = await fetchExistingPersonaAvatars();
    const personas = listPersonas().filter(persona => !existing || existing.has(persona.id));
    const saved = selectedPersonaId();
    const options = ['<option value="">참고하지 않음</option>', `<option value="${MANUAL_PERSONA_ID}">직접 입력</option>`];
    personas.sort((a, b) => (b.id === currentId) - (a.id === currentId));
    const nameCount = personas.reduce((map, p) => map.set(p.name, (map.get(p.name) || 0) + 1), new Map());
    for (const persona of personas) {
        const suffix = nameCount.get(persona.name) > 1 ? ` · ${persona.id.replace(/\.[^.]+$/, '')}` : '';
        const label = `${persona.name}${suffix}${persona.id === currentId ? ' (현재 페르소나)' : ''}`;
        options.push(`<option value="${escapeHtml(persona.id)}">${escapeHtml(label)}</option>`);
    }
    if (saved && saved !== MANUAL_PERSONA_ID && !personas.some(p => p.id === saved)) {
        options.push(`<option value="${escapeHtml(saved)}">(찾을 수 없는 페르소나)</option>`);
    }
    $select.html(options.join('')).val(saved);
    updateBotPersonaInfo();
}

// 실제로 있는 페르소나 아바타 파일 목록 (못 읽으면 null → 거르지 않음)
async function fetchExistingPersonaAvatars() {
    try {
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: getContext().getRequestHeaders({ omitContentType: true }),
        });
        if (!response.ok) return null;
        const list = await response.json();
        return Array.isArray(list) ? new Set(list.map(String)) : null;
    } catch {
        return null;
    }
}

// 내 페르소나 선택은 모드마다 따로 기억 (봇: {{user}}로 등장할 페르소나 / 페르소나: 바탕으로 삼을 페르소나)
function personaSettingKey() {
    return isBotMode() ? 'botPersona' : 'personaBase';
}

function updateBotPersonaInfo() {
    const id = selectedPersonaId();
    const $info = $('#pf-bot-persona-info');
    const manual = id === MANUAL_PERSONA_ID;
    $('#pf-persona-manual-panel').css('display', manual ? '' : 'none');
    if (manual) {
        const saved = getSettings()?.manualPersona || {};
        if (!$('#pf-persona-manual-desc').is(':focus')) $('#pf-persona-manual-desc').val(saved.description || '');
        if (!$('#pf-persona-manual-name').is(':focus')) $('#pf-persona-manual-name').val(saved.name || '');
    }
    if (!id) {
        $info.text('');
        return;
    }
    const persona = manual
        ? { description: String(getSettings()?.manualPersona?.description || '') }
        : listPersonas().find(p => p.id === id);
    if (!persona) {
        $info.text('이 페르소나를 찾을 수 없어 참고하지 않습니다.');
        return;
    }
    const description = persona.description.trim();
    if (!description) {
        $info.text(manual ? '아래에 참고할 페르소나 설명을 적어 주십시오.' : '이 페르소나는 설명이 비어 있어 참고할 내용이 없습니다.');
        return;
    }
    $info.text('설명을 참고합니다.');
    countTokens(description).then(tokens => {
        if (selectedPersonaId() === id) $info.text(`설명 약 ${tokens.toLocaleString()}토큰을 참고합니다.`);
    });
}

const updateBotPersonaInfoSoon = debounce(updateBotPersonaInfo, 400);

const THEME_FONT = 'var(--mainFontFamily, sans-serif)';

// 글자 크기 — 창 전체·모루 남매 대화 배율을 CSS 변수로 (창 안의 크기는 모두 em이라 배율만 바꾸면 됨)
function applyFontScale() {
    const settings = getSettings();
    const root = document.getElementById('persona-forge-popup');
    if (!root || !settings) return;
    root.style.setProperty('--pf-ui-scale', String(FONT_SCALES[settings.uiFontSize]?.ui ?? 1));
    root.style.setProperty('--pf-chat-scale', String(FONT_SCALES[settings.chatFontSize]?.chat ?? 1));
    // 글꼴: 실리태번 테마 글꼴을 고르면 확장 글꼴 대신 테마 글꼴 변수를 씀
    if (settings.uiFontFamily === 'theme') root.style.setProperty('--pf-font', THEME_FONT);
    else root.style.removeProperty('--pf-font');
    $(`input[name="pf-ui-font-family"][value="${settings.uiFontFamily}"]`).prop('checked', true);
    $(`input[name="pf-ui-font"][value="${settings.uiFontSize}"]`).prop('checked', true);
    $(`input[name="pf-chat-font"][value="${settings.chatFontSize}"]`).prop('checked', true);
}

function updateSettingsUI() {
    const settings = getSettings();
    if (!settings) return;
    applyFontScale();

    $(`input[name="pf-gen-mode"][value="${settings.generationMode}"]`).prop('checked', true);
    $('#pf-guided-input').toggle(settings.generationMode === 'guided');

    $('#pf-template-select').val(settings.templatePreset || 'standard');
    updateTemplateDisplay();

    $('#pf-language').val(settings.language || 'en');

    $('#pf-api-profile').val(settings.connectionProfile || '');
    $('#pf-max-tokens').val(Number(settings.maxTokens) || 0);

    $('#pf-wi-toggle').prop('checked', settings.includeWorldInfo);
    $('#pf-wi-container').toggle(settings.includeWorldInfo);

    $('#pf-spoiler-toggle').prop('checked', !!settings.spoilerProtection);
    $('#pf-spoiler-note').toggle(!!settings.spoilerProtection);

    $('#pf-stream-toggle').prop('checked', !!settings.streamRequests);
    $('#pf-density').val(DENSITY_LEVELS[settings.density] ? settings.density : 'default');
    updateDensityDesc();

    const manual = settings[manualStoreKey()] || {};
    $('#pf-manual-name').val(manual.name || '');
    $('#pf-manual-desc').val(manual.description || '');

    const direction = BOT_DIRECTIONS[settings.botDirection] ? settings.botDirection : 'relational';
    $(`input[name="pf-bot-direction"][value="${direction}"]`).prop('checked', true);
    const greetingLength = GREETING_LENGTHS[settings.greetingLength] ? settings.greetingLength : 'medium';
    $(`input[name="pf-greeting-length"][value="${greetingLength}"]`).prop('checked', true);
    $('#pf-greeting-length-custom').val(settings.greetingLengthCustom || '');
    updateGreetingLengthInput();
    const greetingPov = GREETING_POVS[settings.greetingPov] ? settings.greetingPov : 'third';
    $(`input[name="pf-greeting-pov"][value="${greetingPov}"]`).prop('checked', true);

    $('#pf-sheet-text').val(settings.sheetTemplate || '');

    $('#pf-sound-toggle').prop('checked', settings.completionSound !== false);
    $('#pf-setting-toggle').prop('checked', !!settings.includeSetting);
    $('#pf-character-toggle').prop('checked', settings.includeCharacter !== false);
    renderSettingPanel();
    $('#pf-autosave-toggle').prop('checked', settings.autoSaveHistory || false);
}

function findCharacterIndex(charKey) {
    if (!charKey) return -1;
    return (getContext().characters || []).findIndex(c => getCharacterKey(c) === charKey);
}

function isManualTarget() {
    return state.selectedCharKey === MANUAL_CHARACTER_KEY;
}

function manualStoreKey() {
    return isBotMode() ? 'botNotes' : 'manualCharacter';
}

function selectManualTarget() {
    state.selectedCharIndex = -1;
    state.selectedCharKey = MANUAL_CHARACTER_KEY;
    state.selectedCharData = makeManualCharacter(getSettings()[manualStoreKey()]);
}

function selectNoCharacter() {
    state.selectedCharIndex = -1;
    state.selectedCharKey = NO_CHARACTER_KEY;
    state.selectedCharData = null;
}

function hasWorldInfoSource() {
    return !!state.selectedCharData || state.selectedCharKey === NO_CHARACTER_KEY;
}

function updateTargetPanels() {
    $('#pf-manual-panel').toggle(isManualTarget());
    $('#pf-card-fields').toggle(!isManualTarget() && !!state.selectedCharData);
}

function onManualInput() {
    const settings = getSettings();
    const key = manualStoreKey();
    settings[key] = {
        name: String($('#pf-manual-name').val() || ''),
        description: String($('#pf-manual-desc').val() || ''),
    };
    saveSettings();
    if (isManualTarget()) state.selectedCharData = makeManualCharacter(settings[key]);
}

// 이름이 같은 캐릭터가 여럿이면 파일 이름을 붙여 구분
function characterLabel(char, chars) {
    const same = chars.filter(other => other?.name === char.name).length > 1;
    return same && char.avatar ? `${char.name} (${char.avatar.replace(/\.[a-z]+$/i, '')})` : char.name;
}

// 검색어가 있으면 이름에 들어간 캐릭터만 (지금 고른 캐릭터는 항상 남김)
function renderCharacterOptions(query = '') {
    const chars = getContext().characters || [];
    const $select = $('#pf-char-select');
    const current = String($select.val() ?? '');
    const bot = isBotMode();
    const q = query.trim().toLowerCase();
    let options = '<option value="-1">참고하지 않음</option>'
        + `<option value="manual">${bot ? '✎ 직접 입력 (설정·프로필 붙여넣기)' : '✎ 직접 입력'}</option>`;
    chars.forEach((char, idx) => {
        if (!char?.name) return;
        if (!q || char.name.toLowerCase().includes(q) || String(idx) === current) {
            options += `<option value="${idx}">${escapeHtml(characterLabel(char, chars))}</option>`;
        }
    });
    $select.html(options);
    if (current) $select.val(current);
}

const CHAR_RESULTS_STEP = 8;
let charResultsShown = CHAR_RESULTS_STEP;

function findCharacters(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const chars = getContext().characters || [];
    return chars
        .map((char, index) => ({ index, name: char?.name || '', label: char?.name ? characterLabel(char, chars) : '' }))
        .filter(item => item.name.toLowerCase().includes(q));
}

// 검색 결과를 월드인포처럼 눌러서 고르는 목록 (많으면 더 보기)
function renderCharacterResults() {
    const $box = $('#pf-char-results');
    const query = String($('#pf-char-search').val() || '');
    if (!query.trim()) {
        $box.hide().empty();
        return;
    }
    const matches = findCharacters(query);
    if (!matches.length) {
        $box.html('<div class="pf-char-result-empty">이름이 맞는 캐릭터가 없습니다.</div>').show();
        return;
    }
    const current = String($('#pf-char-select').val() ?? '');
    const shown = matches.slice(0, charResultsShown);
    let html = shown.map(item => `
        <button type="button" class="pf-char-result${String(item.index) === current ? ' selected' : ''}" data-index="${item.index}">${escapeHtml(item.label)}</button>`).join('');
    if (matches.length > shown.length) {
        html += `<button type="button" class="pf-char-result-more">더 보기 (${matches.length - shown.length}개 더)</button>`;
    }
    $box.html(html).show();
}

function onCharacterSearchInput() {
    charResultsShown = CHAR_RESULTS_STEP;
    renderCharacterOptions($('#pf-char-search').val());
    renderCharacterResults();
}

function pickCharacter(index) {
    $('#pf-char-search').val('');
    renderCharacterOptions();
    renderCharacterResults();
    $('#pf-char-select').val(String(index)).trigger('change');
}

function onCharacterSearchEnter() {
    const [first] = findCharacters($('#pf-char-search').val());
    if (!first) return showToast('info', '이름이 맞는 캐릭터가 없습니다.');
    pickCharacter(first.index);
}

function populateCharacterDropdown() {
    const context = getContext();
    const chars = context.characters || [];
    const $select = $('#pf-char-select');
    const bot = isBotMode();

    $('#pf-char-search').val('');
    renderCharacterOptions();
    renderCharacterResults();

    if (isManualTarget()) {
        $select.val('manual');
        selectManualTarget();
        updateTargetPanels();
        if (getSettings()?.includeWorldInfo && wiCharKey !== MANUAL_CHARACTER_KEY) refreshWorldInfo();
        else renderWIBooks();
        return;
    }

    if (state.selectedCharKey === NO_CHARACTER_KEY || (bot && !state.selectedCharKey)) {
        $select.val('-1');
        onCharacterSelect();
        return;
    }

    // 이미 고른 캐릭터가 있으면 유지 (팝업을 다시 열어도 작업 중인 대상이 바뀌지 않게)
    const keptIndex = findCharacterIndex(state.selectedCharKey);
    if (keptIndex >= 0) {
        $select.val(keptIndex);
        state.selectedCharIndex = keptIndex;
        state.selectedCharData = chars[keptIndex];
        updateTargetPanels();
        if (chars[keptIndex]?.shallow) {
            ensureFullCharacter(chars[keptIndex]).then(renderCardFields).catch(error => logError('unshallowCharacter', error));
        }
        if (getSettings()?.includeWorldInfo && wiCharKey !== state.selectedCharKey) refreshWorldInfo();
        else renderWIBooks();
        return;
    }

    if (!bot && context.characterId !== undefined && chars[context.characterId]) {
        $select.val(context.characterId);
    }
    onCharacterSelect();
}

async function onCharacterSelect(forcedIndex) {
    if (typeof forcedIndex === 'number') {
        // 검색으로 걸러진 목록에 없을 수 있으므로 검색을 비우고 전체 목록으로
        if ($('#pf-char-search').val()) {
            $('#pf-char-search').val('');
            renderCharacterOptions();
            renderCharacterResults();
        }
        $('#pf-char-select').val(forcedIndex);
    }
    const value = $('#pf-char-select').val();

    if (value === 'manual') {
        selectManualTarget();
        updateTargetPanels();
        renderCardFields();
        if (getSettings()?.includeWorldInfo) await refreshWorldInfo();
        else renderWIBooks();
        return;
    }

    const charIndex = parseInt(value, 10);
    const context = getContext();
    const char = context.characters?.[charIndex];

    if (charIndex < 0 || !char) {
        selectNoCharacter();
        updateTargetPanels();
        renderCardFields();
        if (getSettings()?.includeWorldInfo) await refreshWorldInfo();
        else renderWIBooks();
        return;
    }

    state.selectedCharIndex = charIndex;
    state.selectedCharKey = getCharacterKey(char);
    state.selectedCharData = char;
    updateTargetPanels();
    renderCardFields();

    if (char.shallow) {
        const key = state.selectedCharKey;
        try {
            await ensureFullCharacter(char);
        } catch (error) {
            logError('unshallowCharacter', error);
        }
        if (state.selectedCharKey !== key) return;
        renderCardFields();
    }

    if (getSettings()?.includeWorldInfo) {
        await refreshWorldInfo();
    }
}

let cardTokenRevision = 0;

function renderCardFields() {
    if (isManualTarget()) return;
    const revision = ++cardTokenRevision;
    const char = state.selectedCharData;
    const texts = char ? getCardFieldTexts(char) : {};
    const enabledLabels = [];

    const html = Object.entries(CARD_FIELDS).map(([key, field]) => {
        const enabled = isCardFieldEnabled(key);
        const length = texts[key]?.length || 0;
        if (enabled && length) enabledLabels.push(field.label);
        const size = !char ? '' : (length ? '…' : '없음');
        return `
        <label class="pf-card-field${length || !char ? '' : ' pf-card-field-empty'}">
            <input type="checkbox" class="pf-card-field-cb" data-field="${key}" ${enabled ? 'checked' : ''} ${field.always ? 'disabled' : ''}>
            <span class="pf-card-field-name">${escapeHtml(field.label)}${field.always ? ' <span class="pf-hint-inline">(항상 포함)</span>' : ''}</span>
            <span class="pf-card-field-size" data-field="${key}">${size}</span>
        </label>`;
    }).join('');

    $('#pf-card-fields-list').html(html);
    const labels = enabledLabels.length ? enabledLabels.join(', ') : '포함할 내용 없음';
    $('#pf-card-fields-summary').text(char ? labels : `${Object.keys(CARD_FIELDS).filter(isCardFieldEnabled).length}개 항목`);
    if (!char) return;

    // 토큰 수는 실리태번 토크나이저로 따로 계산 (항목별 + 켠 항목 합계)
    const entries = Object.entries(texts).filter(([, text]) => text);
    Promise.all(entries.map(([, text]) => countTokens(text))).then(counts => {
        if (revision !== cardTokenRevision) return;
        let total = 0;
        entries.forEach(([key], i) => {
            $(`.pf-card-field-size[data-field="${key}"]`).text(`${counts[i].toLocaleString()}토큰`);
            if (isCardFieldEnabled(key)) total += counts[i];
        });
        if (enabledLabels.length) $('#pf-card-fields-summary').text(`${labels} · 약 ${total.toLocaleString()}토큰`);
    });
}

function updateMaxTokensHint() {
    const info = describeConnection();
    const $hint = $('#pf-max-tokens-effective');
    if (info.error) {
        $hint.text(`⚠ ${info.error}`).addClass('pf-effective-warn');
        return;
    }
    const value = info.maxTokens ? info.maxTokens.toLocaleString() : '실리태번 기본값';
    const from = getSettings()?.connectionProfile ? '연결 프로필 설정' : '실리태번 설정';
    const source = info.raisedFrom
        ? `${from} ${info.raisedFrom.toLocaleString()} → 권장값으로 올림`
        : (info.inherited ? from : '직접 지정');
    const low = info.maxTokens && info.maxTokens <= 3000;
    $hint
        .text(`현재 적용: ${value} (${source})${low ? ' — 프로필이 잘릴 수 있을 만큼 작습니다' : ''}`)
        .toggleClass('pf-effective-warn', !!low);
}

let connTestController = null;

// which: main (메인 연결 프로필) | supporter (서포터 연결 프로필 — 비우면 메인 그대로)
async function onConnectionTest(which) {
    if (connTestController || warnIfBusy()) return;
    const supporter = which === 'supporter';
    const $button = $(supporter ? '#pf-supporter-conn-test' : '#pf-conn-test').prop('disabled', true);
    const $status = $(supporter ? '#pf-supporter-conn-status' : '#pf-conn-status')
        .removeClass('pf-effective-warn pf-conn-ok').text('응답을 기다리는 중...').show();
    connTestController = new AbortController();
    const timer = setTimeout(() => connTestController?.abort(), 120000);
    try {
        const connectionProfile = supporter ? (getSettings()?.supporterProfile || undefined) : undefined;
        const { seconds } = await testConnection(connTestController.signal, { connectionProfile });
        $status.text(`연결됨 · 응답 ${seconds.toFixed(1)}초`).addClass('pf-conn-ok');
    } catch (error) {
        const message = isCancelError(error) ? '2분 안에 응답이 없습니다.' : error.message;
        $status.text(`연결 실패: ${message}`).addClass('pf-effective-warn');
    } finally {
        clearTimeout(timer);
        connTestController = null;
        $button.prop('disabled', false);
    }
}

async function onWorldInfoToggle() {
    const enabled = $('#pf-wi-toggle').prop('checked');
    updateSetting('includeWorldInfo', enabled);
    $('#pf-wi-container').toggle(enabled);

    if (enabled && hasWorldInfoSource() && wiCharKey !== state.selectedCharKey) {
        await refreshWorldInfo();
    } else {
        renderWIBooks();
    }
}

async function refreshWorldInfo() {
    const revision = ++wiRevision;
    const charIndex = isManualTarget() || state.selectedCharKey === NO_CHARACTER_KEY
        ? state.selectedCharKey
        : state.selectedCharIndex;

    if (!hasWorldInfoSource()) {
        state.wiBooks = [];
        wiCharKey = '';
        renderWIBooks();
        return;
    }

    $('#pf-wi-books').html('<div class="pf-wi-empty">재료를 수집하는 중...</div>');
    $('#pf-wi-status').text('');

    try {
        const { charKey, books } = await readCharacterWorldInfo(charIndex, getSettings());
        if (revision !== wiRevision) return; // 그 사이 다른 캐릭터를 골랐으면 버림
        if (charKey !== wiCharKey) {
            wiExpandedBooks.clear();
            wiCollapsedBooks.clear();
            // 직접 입력·캐릭터 없음은 연결된 북이 없으므로 전체 목록을 펼쳐 둠
            wiShowOtherBooks = charKey === MANUAL_CHARACTER_KEY || charKey === NO_CHARACTER_KEY;
        }
        state.wiBooks = books;
        wiCharKey = charKey;
        renderWIBooks();
    } catch (error) {
        if (revision !== wiRevision) return;
        logError('refreshWorldInfo', error);
        state.wiBooks = [];
        wiCharKey = state.selectedCharKey; // 실패해도 생성은 막지 않음 (월드인포 없이 진행)
        $('#pf-wi-books').html('<div class="pf-wi-empty">월드인포를 불러올 수 없습니다. 새로고침 버튼으로 다시 시도하십시오.</div>');
    }
}

function findWIBook(key) {
    return (state.wiBooks || []).find(book => book.key === key);
}

function isWIBookExpanded(book) {
    if (wiExpandedBooks.has(book.key)) return true;
    if (wiCollapsedBooks.has(book.key)) return false;
    return book.selected;
}

function getWISearchQuery() {
    return ($('#pf-wi-search').val() || '').trim().toLowerCase();
}

function getVisibleWIEntries(book, query) {
    if (!query || book.name.toLowerCase().includes(query)) return book.entries;
    return book.entries.filter(entry =>
        `${entry.name}\n${entry.keys.join(', ')}\n${entry.content}`.toLowerCase().includes(query));
}

function renderWIEntryHtml(book, entry) {
    const bookKey = escapeHtml(book.key);
    const keys = entry.keys.join(', ');
    const firstLine = entry.content.split(/\r?\n/).find(line => line.trim()) || '';
    const preview = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
    const badges = [
        !entry.content ? '<span class="pf-wi-badge">내용 없음</span>' : '',
        !entry.enabled ? '<span class="pf-wi-badge" title="실리태번에서 꺼져 있는 항목">비활성</span>' : '',
        entry.constant ? '<span class="pf-wi-badge" title="실리태번에서 상시 활성 항목">상시</span>' : '',
    ].join('');

    return `
        <label class="pf-wi-entry${entry.enabled ? '' : ' pf-wi-entry-off'}">
            <input type="checkbox" class="pf-wi-entry-cb" data-book="${bookKey}" data-uid="${escapeHtml(entry.uid)}" ${entry.selected ? 'checked' : ''} ${entry.content ? '' : 'disabled'}>
            <div class="pf-wi-entry-info">
                <div class="pf-wi-entry-name">${escapeHtml(entry.name)}${badges}</div>
                ${keys ? `<div class="pf-wi-entry-keys"><i class="fa-solid fa-key"></i> ${escapeHtml(keys)}</div>` : ''}
                ${preview ? `<div class="pf-wi-entry-preview">${escapeHtml(preview)}</div>` : ''}
            </div>
        </label>`;
}

function renderWIBookHtml(book, query) {
    const visibleEntries = getVisibleWIEntries(book, query);
    if (query && !book.name.toLowerCase().includes(query) && !visibleEntries.length) return '';

    const key = escapeHtml(book.key);
    const expanded = book.selected && (isWIBookExpanded(book) || (!!query && visibleEntries.length > 0));
    const badges = book.sources.map(source => {
        const warn = source === WI_SOURCES.persona && !isBotMode();
        const title = warn ? ' title="현재 페르소나에 연결된 로어북입니다. 선택하면 기존 페르소나 설정이 결과에 섞일 수 있습니다."' : '';
        return `<span class="pf-wi-badge${warn ? ' pf-wi-badge-warn' : ' pf-wi-badge-source'}"${title}>${warn ? '⚠ ' : ''}${escapeHtml(source)}</span>`;
    }).join('');
    const count = book.selected && book.loaded
        ? `<span class="pf-wi-book-count">${book.entries.filter(e => e.selected).length}/${book.entries.length}</span>`
        : '';

    let body = '';
    if (book.selected && book.error) {
        body = `<div class="pf-wi-book-message">${escapeHtml(book.error)}</div>`;
    } else if (book.selected && !book.loaded) {
        body = '<div class="pf-wi-book-message">불러오는 중...</div>';
    } else if (expanded) {
        const filtered = visibleEntries.length !== book.entries.length;
        body = `
            <div class="pf-wi-book-body">
                <div class="pf-wi-bulk">
                    <button class="pf-btn pf-small-btn pf-wi-bulk-btn" data-book="${key}" data-select="all">${filtered ? '검색 결과 선택' : '전체 선택'}</button>
                    <button class="pf-btn pf-small-btn pf-wi-bulk-btn" data-book="${key}" data-select="none">${filtered ? '검색 결과 해제' : '전체 해제'}</button>
                    <button class="pf-btn pf-small-btn pf-wi-bulk-btn" data-book="${key}" data-select="enabled" title="실리태번에서 켜져 있는 항목만 선택">켜진 항목만</button>
                </div>
                <div class="pf-wi-entries" data-book="${key}">
                    ${visibleEntries.map(entry => renderWIEntryHtml(book, entry)).join('') || '<div class="pf-wi-empty">항목이 없습니다.</div>'}
                </div>
            </div>`;
    }

    return `
    <div class="pf-wi-book${book.selected ? ' selected' : ''}" data-book="${key}">
        <div class="pf-wi-book-head">
            <label class="pf-wi-book-label">
                <input type="checkbox" class="pf-wi-book-cb" data-book="${key}" ${book.selected ? 'checked' : ''}>
                <span class="pf-wi-book-name">${escapeHtml(book.name)}</span>
                ${badges}
            </label>
            ${count}
            ${book.selected && book.loaded ? `<button class="pf-wi-book-expand pf-icon-btn-sm" data-book="${key}" title="항목 펼치기/접기"><i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}"></i></button>` : ''}
        </div>
        ${body}
    </div>`;
}

function renderWIBooks() {
    const $books = $('#pf-wi-books');

    if (!hasWorldInfoSource()) {
        $books.html('<div class="pf-wi-empty">캐릭터를 고르거나 "참고하지 않음"을 선택하십시오.</div>');
        $('#pf-wi-status').text('');
        return;
    }

    const books = state.wiBooks || [];
    const query = getWISearchQuery();

    const scrolls = new Map();
    $books.find('.pf-wi-entries').each(function () {
        scrolls.set($(this).attr('data-book'), this.scrollTop);
    });

    let html = '';
    if (query) {
        html = books.map(book => renderWIBookHtml(book, query)).join('') || '<div class="pf-wi-empty">검색 결과 없음</div>';
    } else {
        const related = books.filter(book => book.sources.length || book.selected);
        const others = books.filter(book => !book.sources.length && !book.selected);

        let emptyText = '이 캐릭터에 연결된 월드인포가 없습니다.';
        if (isManualTarget()) emptyText = '직접 입력한 내용에는 연결된 월드인포가 없습니다. 아래 목록에서 골라 주십시오.';
        else if (state.selectedCharKey === NO_CHARACTER_KEY) emptyText = '필요한 월드인포를 아래 목록에서 골라 주십시오.';
        html = related.map(book => renderWIBookHtml(book, '')).join('')
            || `<div class="pf-wi-empty">${emptyText}</div>`;

        if (others.length) {
            html += `
            <button id="pf-wi-other-toggle" class="pf-wi-other-toggle" type="button">
                <i class="fa-solid fa-chevron-${wiShowOtherBooks ? 'up' : 'down'}"></i>
                다른 월드인포 ${others.length}개 ${wiShowOtherBooks ? '접기' : '펼치기'}
            </button>`;
            if (wiShowOtherBooks) html += others.map(book => renderWIBookHtml(book, '')).join('');
        }
    }

    $books.html(html);
    $books.find('.pf-wi-entries').each(function () {
        const top = scrolls.get($(this).attr('data-book'));
        if (top) this.scrollTop = top;
    });
    updateWIStatus();
}

let wiTokenTimer = null;
let wiTokenRevision = 0;

function updateWIStatus() {
    clearTimeout(wiTokenTimer);
    const revision = ++wiTokenRevision;
    if (!hasWorldInfoSource()) {
        $('#pf-wi-status').text('');
        return;
    }
    const entries = getSelectedEntries(state.wiBooks);
    const failed = (state.wiBooks || []).filter(book => book.selected && book.error).length;
    const render = size => $('#pf-wi-status').text(`${entries.length}개 항목 선택${size}${failed ? ` · 읽기 실패 ${failed}개` : ''}`);
    render(entries.length ? ' · 토큰 계산 중' : '');
    if (!entries.length) return;
    wiTokenTimer = setTimeout(async () => {
        const tokens = await countTokens(entries.map(entry => entry.content).join('\n\n'));
        if (revision === wiTokenRevision) render(` · 본문 약 ${tokens.toLocaleString()}토큰`);
    }, 300);
}

async function onWIBookToggle() {
    const key = $(this).attr('data-book');
    const book = findWIBook(key);
    if (!book) return;

    book.selected = $(this).prop('checked');
    storeBookSelected(getSettings(), wiCharKey, key, book.selected);
    saveSettings();

    if (book.selected) {
        wiCollapsedBooks.delete(key);
        wiExpandedBooks.add(key);
        if (!book.loaded) {
            renderWIBooks();
            const revision = wiRevision;
            await loadBookEntries(book, getSettings(), wiCharKey);
            if (revision !== wiRevision) return;
        }
    }
    renderWIBooks();
}

function onWIBookExpandToggle(e) {
    e.preventDefault();
    const key = $(this).attr('data-book');
    const book = findWIBook(key);
    if (!book) return;

    if (isWIBookExpanded(book)) {
        wiExpandedBooks.delete(key);
        wiCollapsedBooks.add(key);
    } else {
        wiCollapsedBooks.delete(key);
        wiExpandedBooks.add(key);
    }
    renderWIBooks();
}

function onWIBulkSelect() {
    const key = $(this).attr('data-book');
    const mode = $(this).attr('data-select');
    const book = findWIBook(key);
    if (!book?.loaded) return;

    const settings = getSettings();
    for (const entry of getVisibleWIEntries(book, getWISearchQuery())) {
        if (!entry.content) continue;
        entry.selected = mode === 'enabled' ? entry.enabled : mode === 'all';
        storeEntrySelected(settings, wiCharKey, key, entry.uid, entry.selected);
    }
    saveSettings();
    renderWIBooks();
}

function onWIEntryToggle() {
    const key = $(this).attr('data-book');
    const uid = $(this).attr('data-uid');
    const book = findWIBook(key);
    const entry = book?.entries.find(e => e.uid === uid);
    if (!entry) return;

    entry.selected = $(this).prop('checked');
    storeEntrySelected(getSettings(), wiCharKey, key, uid, entry.selected);
    saveSettings();

    $(this).closest('.pf-wi-book').find('.pf-wi-book-count')
        .text(`${book.entries.filter(e => e.selected).length}/${book.entries.length}`);
    updateWIStatus();
}

function onModeChange() {
    const mode = $('input[name="pf-gen-mode"]:checked').val();
    updateSetting('generationMode', mode);
    $('#pf-guided-input').toggle(mode === 'guided');
}

function onAutoSaveToggle() {
    const enabled = $(this).prop('checked');
    updateSetting('autoSaveHistory', enabled);
}

function populateAPIProfiles() {
    const profiles = getConnectionProfiles();
    const $select = $('#pf-api-profile');
    const currentVal = getSettings()?.connectionProfile || '';

    $select.empty();
    $select.append('<option value="">현재 연결 사용</option>');

    for (const profile of profiles) {
        $select.append(`<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`);
    }

    // 저장된 프로필이 삭제된 경우 조용히 다른 API로 바뀌지 않도록 표시
    if (currentVal && !profiles.some(p => p.id === currentVal)) {
        $select.append(`<option value="${escapeHtml(currentVal)}">⚠ 찾을 수 없는 프로필 — 다시 선택하십시오</option>`);
    }

    $select.val(currentVal);

    const supporter = getSettings()?.supporterProfile || '';
    const $support = $('#pf-supporter-profile');
    $support.html(['<option value="">메인 연결 프로필 그대로</option>',
        ...profiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`),
        supporter && !profiles.some(p => p.id === supporter) ? `<option value="${escapeHtml(supporter)}">⚠ 찾을 수 없는 프로필 — 다시 선택하십시오</option>` : '',
    ].join('')).val(supporter);
}

function onTemplateChange() {
    const presetId = $('#pf-template-select').val();
    updateSetting('templatePreset', presetId);
    updateTemplateDisplay();
}

function updateTemplateDisplay() {
    const presetId = getSettings()?.templatePreset || 'standard';
    const isChoice = presetId === 'choice';
    const isCustomSheet = presetId === 'custom';
    const isMirror = presetId === MIRROR_TEMPLATE.id;

    const preset = TEMPLATE_PRESETS[presetId];
    if (preset) {
        $('#pf-template-desc').text(preset.description);
    } else if (isChoice) {
        $('#pf-template-desc').text('');
    } else if (isCustomSheet) {
        $('#pf-template-desc').text('나만의 프로필 시트 양식을 직접 입력하십시오.');
    } else if (isMirror) {
        $('#pf-template-desc').text('참고 자료 속 캐릭터 설명과 같은 틀로 만듭니다. 라벨·헤더는 원본 그대로 두고, 맞지 않는 항목은 빼거나 바꿉니다. 지시문·규칙·세계관 설명은 제외됩니다.');
    }
    // 봇 모드에서는 세계관 설정이 빠지는 템플릿을 이름에 표시
    const excludeNote = isBotMode() ? ' / 세계관 설정 제외' : '';
    $('#pf-template-select option[value="mirror"]').text(`Mirror (기존 캐릭터 참고${excludeNote})`);
    $('#pf-template-select option[value="custom"]').text(`Custom (자유 입력${excludeNote})`);

    // 봇 모드에서 캐릭터 설정을 끄면 세계관만 — 템플릿과 설계 방향(인물 기준)은 쓰지 않음
    const withCharacter = characterOn();
    $('#pf-character-toggle').prop('checked', withCharacter);
    if (!withCharacter) $('#pf-template-desc').text('캐릭터 프로필 없이 세계관만 만듭니다.');
    $('#pf-template-ctrl, #pf-template-fields').css('display', withCharacter ? '' : 'none');
    $('#pf-direction-group').css('display', withCharacter ? '' : 'none');
    // 버튼 이름: 캐릭터를 만들면 "캐릭터 생성", 세계관만이면 "세계관 생성", 둘 다 끄면 "봇 생성"
    const settingOn = !!getSettings()?.includeSetting;
    $('#pf-generate-bot-label').text(withCharacter ? '캐릭터 생성' : (settingOn ? '세계관 생성' : '봇 생성'));
    renderSettingPanel();

    $('#pf-custom-panel').toggle(withCharacter && isChoice);

    $('#pf-sheet-panel').toggle(withCharacter && isCustomSheet);

    if (isCustomSheet || isMirror) $('#pf-template-fields').empty();
    else renderFieldTags('profile', '#pf-template-fields', isChoice ? null : (preset?.fields || []));

    if (withCharacter && isChoice) {
        renderFieldList('profile');
    }
}

// 고른 항목을 이름표로 (ids를 안 주면 그 목록에서 고른 항목)
function renderFieldTags(set, selector, ids = null) {
    const resolve = FIELD_SETS[set].resolve;
    $(selector).html((ids || selectedFieldIds(set)).map(id => {
        const field = resolve(id);
        if (!field) return '';
        return `<span class="pf-field-tag${field.nsfw ? ' nsfw' : ''}"><i class="${escapeHtml(field.icon || 'fa-solid fa-star')}"></i> ${escapeHtml(field.label)}</span>`;
    }).join(''));
}

function getEffectiveFieldUI(fieldId) {
    return getEffectiveField(fieldId, isBotMode() ? 'bot' : 'persona');
}

// Choice 목록 두 가지 — 캐릭터 설정(프로필 필드)과 세계관 설정(세계관 항목)이 같은 방식으로 동작
// 목록·버튼은 가장 가까운 [data-set]으로 어느 쪽인지 구분
const FIELD_SETS = {
    profile: {
        base: PROFILE_FIELDS,
        selectedKey: 'customFields',
        defsKey: 'customFieldDefinitions',
        resolve: id => getEffectiveFieldUI(id),
        list: '#pf-custom-field-list',
        sortableId: 'pf-selected-field-list',
        noun: '항목',
        newItem: { label: '새 항목', labelEn: 'NEW SECTION', description: 'Describe what this section should contain', descriptionKo: '새 항목 설명' },
        examples: { label: '예: 기본 정보', labelEn: '예: BASICS', desc: '예: Name, Age, Sex, Race', descKo: '예: 이름, 나이, 성별, 종족' },
        refresh: () => updateTemplateDisplay(),
    },
    setting: {
        base: SETTING_FIELDS,
        selectedKey: 'settingFields',
        defsKey: 'settingFieldDefinitions',
        resolve: id => getEffectiveSettingField(id),
        list: '#pf-setting-field-list',
        sortableId: 'pf-selected-setting-list',
        noun: '항목',
        newItem: { label: '새 항목', labelEn: 'NEW SECTION', description: 'Describe what this section should contain', descriptionKo: '새 항목 설명' },
        examples: { label: '예: 마법 체계', labelEn: '예: MAGIC', desc: '예: how magic works, who can use it, and what it costs', descKo: '예: 마법의 원리, 쓸 수 있는 사람, 대가' },
        refresh: () => renderSettingPanel(),
    },
};

function fieldSetOf(el) {
    return $(el).closest('[data-set]').attr('data-set') === 'setting' ? 'setting' : 'profile';
}

function fieldItem(set, fieldId) {
    return $(`.pf-custom-field-item[data-set="${set}"][data-field-id="${fieldId}"]`);
}

// 은/는, 을/를, 이/가 — 받침 여부로
function josa(word, withBatchim, without) {
    const code = String(word || '').trim().slice(-1).charCodeAt(0) - 0xAC00;
    if (code < 0 || code > 11171) return `${withBatchim}(${without})`;
    return code % 28 ? withBatchim : without;
}

function getAllFieldIds(set = 'profile') {
    const { base, defsKey } = FIELD_SETS[set];
    const customIds = Object.keys(getSettings()?.[defsKey] || {}).filter(id => id.startsWith('custom_'));
    return [...Object.keys(base), ...customIds];
}

function selectedFieldIds(set) {
    const all = getAllFieldIds(set);
    return (getSettings()?.[FIELD_SETS[set].selectedKey] || []).filter(id => all.includes(id));
}

function renderFieldItemHtml(set, fieldId, { order = 0, total = 0 } = {}) {
    const settings = getSettings();
    const { resolve, defsKey, noun } = FIELD_SETS[set];
    const field = resolve(fieldId);
    if (!field) return '';

    const selected = order > 0;
    const nsfwClass = field.nsfw ? ' nsfw-field' : '';
    const isCustom = fieldId.startsWith('custom_');
    const isModified = !!settings?.[defsKey]?.[fieldId] && !isCustom;
    const modifiedBadge = isModified ? '<span class="pf-field-modified-badge" title="수정됨">*</span>' : '';
    const id = escapeHtml(fieldId);

    const orderControls = selected ? `
        <span class="pf-field-drag" title="끌어서 순서 변경"><i class="fa-solid fa-grip-vertical"></i></span>
        <span class="pf-field-order-num">${order}</span>` : '';
    const moveButtons = selected ? `
        <button class="pf-field-move-btn pf-icon-btn-sm" data-field-id="${id}" data-dir="up" title="위로" ${order === 1 ? 'disabled' : ''}>
            <i class="fa-solid fa-chevron-up"></i>
        </button>
        <button class="pf-field-move-btn pf-icon-btn-sm" data-field-id="${id}" data-dir="down" title="아래로" ${order === total ? 'disabled' : ''}>
            <i class="fa-solid fa-chevron-down"></i>
        </button>` : '';

    return `
    <div class="pf-custom-field-item${nsfwClass}${selected ? ' selected' : ''}" data-set="${set}" data-field-id="${id}">
        <div class="pf-field-item-main">
            ${orderControls}
            <label class="pf-field-check">
                <input type="checkbox" class="pf-custom-field-cb" data-field="${id}" ${selected ? 'checked' : ''}>
                <span class="pf-field-icon"><i class="${escapeHtml(field.icon || 'fa-solid fa-star')}"></i></span>
                <span class="pf-field-name">${escapeHtml(field.label)}${modifiedBadge}</span>
            </label>
            <div class="pf-field-item-actions">
                ${moveButtons}
                <button class="pf-field-edit-btn pf-icon-btn-sm" data-field-id="${id}" title="${noun} 편집">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
                ${isCustom ? `<button class="pf-field-delete-btn pf-icon-btn-sm pf-icon-btn-danger" data-field-id="${id}" title="${noun} 삭제">
                    <i class="fa-solid fa-trash-can"></i>
                </button>` : ''}
            </div>
        </div>
        <span class="pf-field-desc-text">${escapeHtml(field.descriptionKo || field.description || '')}</span>
    </div>`;
}

function renderFieldList(set) {
    const { list, sortableId, noun, selectedKey, refresh } = FIELD_SETS[set];
    const selectedIds = selectedFieldIds(set);
    const unselectedIds = getAllFieldIds(set).filter(id => !selectedIds.includes(id));
    const $list = $(list);

    let html = `<div class="pf-field-group-label">선택된 ${noun} <span class="pf-hint-inline">— 이 순서대로 작성됩니다. 손잡이를 끌거나 ▲▼로 순서 변경</span></div>`;
    html += selectedIds.length
        ? `<div id="${sortableId}" class="pf-custom-fields">${selectedIds.map((id, idx) => renderFieldItemHtml(set, id, { order: idx + 1, total: selectedIds.length })).join('')}</div>`
        : `<div class="pf-field-group-empty">아래 목록에서 포함할 ${noun}${josa(noun, '을', '를')} 체크하십시오.</div>`;

    if (unselectedIds.length) {
        html += `<div class="pf-field-group-label">추가 가능한 ${noun}</div>`;
        html += `<div class="pf-custom-fields">${unselectedIds.map(id => renderFieldItemHtml(set, id)).join('')}</div>`;
    }

    $list.html(html);

    // 드래그 정렬 (실리태번 내장 jQuery UI — 모바일은 touch-punch로 지원)
    const $sortable = $(`#${sortableId}`);
    if ($sortable.length && typeof $sortable.sortable === 'function') {
        $sortable.sortable({
            handle: '.pf-field-drag',
            items: '> .pf-custom-field-item',
            axis: 'y',
            tolerance: 'pointer',
            stop: () => {
                const ids = $sortable.children('.pf-custom-field-item').map(function () {
                    return $(this).attr('data-field-id');
                }).get();
                updateSetting(selectedKey, ids);
                refresh();
            },
        });
    } else {
        $list.find('.pf-field-drag').hide();
    }
}

function onCustomFieldToggle() {
    const set = fieldSetOf(this);
    const { selectedKey, refresh } = FIELD_SETS[set];
    const fieldId = $(this).attr('data-field');
    const fields = selectedFieldIds(set).filter(id => id !== fieldId);
    if ($(this).prop('checked')) fields.push(fieldId);
    updateSetting(selectedKey, fields);
    refresh();
}

function onFieldMove(e) {
    e.preventDefault();
    const set = fieldSetOf(this);
    const { selectedKey, refresh } = FIELD_SETS[set];
    const fieldId = $(this).attr('data-field-id');
    const step = $(this).attr('data-dir') === 'up' ? -1 : 1;
    const fields = selectedFieldIds(set);
    const from = fields.indexOf(fieldId);
    const to = from + step;
    if (from < 0 || to < 0 || to >= fields.length) return;

    [fields[from], fields[to]] = [fields[to], fields[from]];
    updateSetting(selectedKey, fields);
    refresh();
    fieldItem(set, fieldId)[0]?.scrollIntoView({ block: 'nearest' });
}

function onFieldEditToggle() {
    const set = fieldSetOf(this);
    const { resolve, examples, noun } = FIELD_SETS[set];
    const fieldId = String($(this).attr('data-field-id'));
    const $item = fieldItem(set, fieldId);
    const $existing = $item.find('.pf-field-edit-form');

    if ($existing.length) {
        $existing.remove();
        return;
    }

    $('.pf-field-edit-form').remove();

    const field = resolve(fieldId);
    if (!field) return;

    const form = `
    <div class="pf-field-edit-form">
        <div class="pf-field-edit-row">
            <label>한국어 이름</label>
            <textarea class="pf-textarea pf-autogrow pf-field-edit-label" rows="1" placeholder="${escapeHtml(examples.label)}">${escapeHtml(field.label)}</textarea>
        </div>
        <div class="pf-field-edit-row">
            <label>영문 헤더 <span class="pf-hint-inline">프롬프트에 ## 헤더로 사용</span></label>
            <textarea class="pf-textarea pf-autogrow pf-field-edit-labelEn" rows="1" placeholder="${escapeHtml(examples.labelEn)}">${escapeHtml(field.labelEn)}</textarea>
        </div>
        <div class="pf-field-edit-row">
            <label>세부 설명 (EN) <span class="pf-hint-inline">프롬프트에 이 ${noun}의 세부 지시로 사용</span></label>
            <textarea class="pf-textarea pf-autogrow pf-field-edit-desc" rows="1" placeholder="${escapeHtml(examples.desc)}">${escapeHtml(field.description)}</textarea>
        </div>
        <div class="pf-field-edit-row">
            <label>세부 설명 (KO) <span class="pf-hint-inline">화면 표시용</span></label>
            <textarea class="pf-textarea pf-autogrow pf-field-edit-descKo" rows="1" placeholder="${escapeHtml(examples.descKo)}">${escapeHtml(field.descriptionKo || '')}</textarea>
        </div>
        <div class="pf-field-edit-form-actions">
            <button class="pf-field-edit-save pf-primary-btn pf-small-btn" data-field-id="${escapeHtml(fieldId)}"><i class="fa-solid fa-check"></i> 저장</button>
            <button class="pf-field-edit-cancel pf-btn pf-small-btn" data-field-id="${escapeHtml(fieldId)}">취소</button>
        </div>
    </div>`;

    $item.append(form);
    $item.find('.pf-autogrow').each(function () { autoGrow(this); });
}

// 한 줄 입력칸이지만 길면 줄바꿈되어 아래로 늘어남 (모바일에서 가로로 잘려 보이지 않게)
function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
}

// 편집 칸을 내용 높이에 맞춤 — 너무 길면 화면 높이의 60%에서 멈추고 스크롤
function fitToContent(el) {
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.max(160, Math.round(window.innerHeight * 0.6));
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`;
}

function onFieldEditSave() {
    const set = fieldSetOf(this);
    const { resolve, defsKey, noun, refresh } = FIELD_SETS[set];
    const fieldId = String($(this).attr('data-field-id'));
    const $form = fieldItem(set, fieldId).find('.pf-field-edit-form');

    const read = selector => String($form.find(selector).val() || '').replace(/\s*\n+\s*/g, ' ').trim();
    const label = read('.pf-field-edit-label');
    const labelEn = read('.pf-field-edit-labelEn');
    const description = read('.pf-field-edit-desc');
    const descriptionKo = read('.pf-field-edit-descKo');

    if (!label || !labelEn || !description) {
        showToast('warning', '한국어 이름, 영문 헤더, 세부 설명(EN)은 필수입니다.');
        return;
    }

    const defs = { ...(getSettings()[defsKey] || {}) };
    defs[fieldId] = {
        label,
        labelEn,
        description,
        descriptionKo: descriptionKo || label,
        icon: resolve(fieldId)?.icon || 'fa-solid fa-star',
        ...(fieldId.startsWith('custom_') ? { isCustom: true } : {}),
    };

    updateSetting(defsKey, defs);
    refresh();
}

function onFieldEditCancel() {
    const set = fieldSetOf(this);
    fieldItem(set, String($(this).attr('data-field-id'))).find('.pf-field-edit-form').remove();
}

function onCustomFieldAdd() {
    const set = fieldSetOf(this);
    const { defsKey, selectedKey, newItem, noun, refresh } = FIELD_SETS[set];
    const id = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    updateSetting(defsKey, { ...(getSettings()[defsKey] || {}), [id]: { ...newItem, icon: 'fa-solid fa-star', isCustom: true } });
    updateSetting(selectedKey, [...selectedFieldIds(set), id]);
    refresh();

    setTimeout(() => {
        const $newItem = fieldItem(set, id);
        $newItem.find('.pf-field-edit-btn').trigger('click');
        $newItem[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);

}

async function onFieldDelete() {
    const set = fieldSetOf(this);
    const { resolve, defsKey, selectedKey, noun, refresh } = FIELD_SETS[set];
    const fieldId = String($(this).attr('data-field-id'));
    if (!fieldId.startsWith('custom_')) return;

    const name = resolve(fieldId)?.label || fieldId;
    if (!(await askConfirm(`${noun} "${name}"${josa(name, '을', '를')} 삭제하시겠습니까?`))) return;

    const defs = { ...(getSettings()[defsKey] || {}) };
    delete defs[fieldId];
    updateSetting(defsKey, defs);
    updateSetting(selectedKey, selectedFieldIds(set).filter(id => id !== fieldId));

    refresh();
}

async function onCustomFieldReset() {
    const set = fieldSetOf(this);
    const { defsKey, selectedKey, noun, refresh } = FIELD_SETS[set];
    const settings = getSettings();

    if (!Object.keys(settings[defsKey] || {}).length) {
        showToast('info', '초기화할 수정 사항이 없습니다.');
        return;
    }

    if (!(await askConfirm(`모든 ${noun} 수정·추가를 초기화하시겠습니까?\n기본 ${noun}${josa(noun, '은', '는')} 원래대로 돌아가고, 직접 추가한 ${noun}${josa(noun, '은', '는')} 삭제됩니다.`))) return;

    updateSetting(selectedKey, (settings[selectedKey] || []).filter(id => !id.startsWith('custom_')));
    updateSetting(defsKey, {});
    refresh();
}

function warnIfBusy() {
    if (supportController) {
        showToast('warning', `${currentSupporterName()}의 답을 기다리는 중입니다. 답이 온 뒤에 다시 시도하십시오.`);
        return true;
    }
    if (!state.isGenerating) return false;
    showToast('warning', '이미 생성 작업이 진행 중입니다. 끝나거나 취소한 뒤 다시 시도하십시오.');
    return true;
}

async function onGenerateClick() {
    if (warnIfBusy()) return;

    const bot = isBotMode();
    const settingsNow = getSettings();
    if (!bot && !state.selectedCharData
        && !(settingsNow.includeWorldInfo && getSelectedEntries(state.wiBooks).length)) {
        showToast('warning', state.selectedCharKey === NO_CHARACTER_KEY
            ? '캐릭터를 참고하지 않으려면 월드인포를 켜고 참고할 항목을 골라 주십시오.'
            : '캐릭터를 고르거나, "참고하지 않음"을 골라 월드인포만 참고하십시오.');
        return;
    }
    if (isManualTarget() && !String(getSettings()[manualStoreKey()]?.description || '').trim()) {
        showToast('warning', bot
            ? '직접 입력 칸이 비어 있습니다. 내용을 적거나 "참고하지 않음"을 골라 주십시오.'
            : '직접 입력한 기존 캐릭터의 설명을 적어 주십시오.');
        return;
    }

    const settings = getSettings();
    const conceptText = $('#pf-concept-text').val() || '';
    const sheetTemplate = $('#pf-sheet-text').val() || '';

    const withCharacter = characterOn();
    if (bot && !withCharacter && !settings.includeSetting) {
        showToast('warning', '만들 것이 없습니다. "세계관 설정"이나 "캐릭터 설정" 중 하나 이상을 켜 주십시오.');
        return;
    }
    if (withCharacter && settings.templatePreset === 'custom' && !sheetTemplate.trim()) {
        showToast('warning', '자유 입력 양식을 입력해 주십시오.');
        return;
    }

    const settingUsed = bot && settings.includeSetting && (!withCharacter || !SETTINGLESS_TEMPLATES.includes(settings.templatePreset));
    if (settingUsed && !selectedFieldIds('setting').length) {
        showToast('warning', withCharacter
            ? '세계관 항목을 하나 이상 골라 주십시오. (또는 "세계관 설정"을 꺼 주십시오)'
            : '세계관 항목을 하나 이상 골라 주십시오.');
        return;
    }

    if (withCharacter && settings.templatePreset === 'choice' && (!settings.customFields || !settings.customFields.length)) {
        showToast('warning', '항목을 하나 이상 선택해 주십시오.');
        return;
    }

    // 월드인포 목록을 아직 읽는 중이면 선택이 반영되지 않으므로 잠시 기다리게 함
    if (settings.includeWorldInfo && wiCharKey !== state.selectedCharKey) {
        showToast('info', '월드인포 목록을 읽는 중입니다. 잠시 후 다시 눌러 주십시오.');
        refreshWorldInfo();
        return;
    }

    try {
        switchTab('generate');
        showGenerateLoading(true);

        const result = await generatePersona({ conceptText, sheetTemplate });

        renderGenerationResult(result);
        playGlint('.pf-result-toolbar');
        const what = result.worldOnly ? '세계관이' : (result.mode === 'bot' ? '봇 캐릭터가' : '페르소나가');
        showToast(result.incomplete ? 'warning' : 'success',
            result.incomplete ? `${what} 생성됐지만 끝까지 작성되지 않은 것 같습니다.` : pickRandom(DONE_TEXTS[result.worldOnly ? 'world' : (result.mode === 'bot' ? 'bot' : 'persona')]));
        countForged();
        playChime('done');

        autoSaveToHistory();

    } catch (error) {
        if (isCancelError(error)) return;
        logError('generate', error);
        playChime('error');
        showToast('error', `생성 실패: ${error.message}`);
        showGenerateLoading(false);
    }
}

function onCancelGeneration() {
    cancelOperation();
    showGenerateLoading(false);
}

// 기다리는 동안 문구를 돌려 보여줌 — 오래 걸리면 사이사이 기다림 문구를 끼움
// 멈출 때는 받은 번호로 멈춤 (취소 뒤 늦게 끝난 이전 작업이 새 작업의 문구를 멈추지 않게)
function startLoadingText(selector, kind) {
    clearInterval(loadingTextTimer);
    const texts = LOADING_TEXTS[kind] || LOADING_TEXTS.persona;
    const $text = $(selector);
    const startedAt = Date.now();
    let index = 0;
    let tick = 0;
    const show = (text) => {
        if ($text.text() === text) return;
        $text.removeClass('pf-loading-text-fade');
        void $text[0]?.offsetWidth;
        $text.text(text).addClass('pf-loading-text-fade');
    };
    $text.removeClass('pf-loading-text-fade').text(texts[0]);
    const timer = setInterval(() => {
        tick += 1;
        const waited = (Date.now() - startedAt) / 1000;
        const longWait = LONG_WAIT_TEXTS.filter(([seconds]) => waited >= seconds).pop();
        if (longWait && tick % 2 === 0) {
            show(longWait[1]);
        } else {
            index = (index + 1) % texts.length;
            show(texts[index]);
        }
    }, 3500);
    loadingTextTimer = timer;
    return timer;
}

function stopLoadingText(timer = loadingTextTimer) {
    clearInterval(timer);
    if (timer === loadingTextTimer) loadingTextTimer = null;
}

function showGenerateLoading(show, kind = null) {
    $('#pf-gen-loading').toggle(show);
    $('#pf-gen-empty').toggle(!show && !state.currentGeneration);
    // jQuery toggle 대신 직접 — 보일 때 인라인 값을 비워 CSS(flex)가 그대로 적용되게
    $('#pf-gen-result').css('display', !show && state.currentGeneration ? '' : 'none');
    $('#pf-generate-btn').prop('disabled', show);

    if (show) {
        scrollGenerateTabToTop();
        setEditMode(false);
        startLoadingText('#pf-gen-loading-text', kind || (isBotMode() ? (characterOn() ? 'bot' : 'world') : 'persona'));
        startProgress('#pf-gen-progress');
    } else {
        stopLoadingText();
        stopProgress('#pf-gen-progress');
    }
}

let progressTimer = null;
let progressFrame = 0;

function startProgress(selector) {
    clearInterval(progressTimer);
    cancelAnimationFrame(progressFrame);
    progressFrame = 0;
    const startedAt = Date.now();
    let chars = 0;
    let reasoning = 0;
    const render = () => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        const time = seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
        let text;
        if (chars > 0) text = `받는 중 · ${chars.toLocaleString()}자 · ${time}`;
        else if (reasoning > 0) text = `생각하는 중 · ${reasoning.toLocaleString()}자 · ${time}`;
        else text = `응답을 기다리는 중 · ${time}`;
        $(selector).text(text);
        $('#pf-busy-progress').text(text);
    };
    // 스트리밍 조각은 초당 수십~수백 번 오므로 화면은 프레임당 한 번만 갱신
    state.progressListener = (textChars, reasoningChars = 0) => {
        chars = textChars;
        reasoning = reasoningChars;
        if (!progressFrame) progressFrame = requestAnimationFrame(() => { progressFrame = 0; render(); });
    };
    render();
    progressTimer = setInterval(render, 1000);
}

function stopProgress(selector) {
    clearInterval(progressTimer);
    cancelAnimationFrame(progressFrame);
    progressTimer = null;
    progressFrame = 0;
    state.progressListener = null;
    if (selector) $(selector).text('');
    $('#pf-busy-progress').text('');
}

function renderGenerationResult(data) {
    if (!data) return;
    scrollGenerateTabToTop();

    showGenerateLoading(false);
    $('#pf-gen-empty').hide();
    $('#pf-gen-result').css('display', '');

    const langLabel = LANGUAGES[data.language]?.label || data.language;
    let templateLabel;
    if (data.templateId === 'custom') {
        templateLabel = 'Custom (자유 입력)';
    } else if (data.templateId === MIRROR_TEMPLATE.id) {
        templateLabel = MIRROR_TEMPLATE.label;
    } else if (data.templateId === 'manual') {
        templateLabel = '직접 추가';
    } else if (data.templateId === 'world') {
        templateLabel = '세계관만';
    } else if (data.templateId === 'choice') {
        templateLabel = 'Choice (선택)';
    } else {
        templateLabel = TEMPLATE_PRESETS[data.templateId]?.label || data.templateId;
    }
    $('#pf-gen-result').toggleClass('pf-gen-bot', data.mode === 'bot');
    // 직접 추가한 프로필은 처음부터 다시 만들 조건이 없어 전체 재생성을 숨김 (섹션 재생성·수정·번역은 가능)
    $('#pf-regen-all-btn').css('display', data.templateId === 'manual' ? 'none' : '');
    refreshResultHeader(data);
    renderResultConcept(data);
    $('#pf-result-template').text(templateLabel);
    $('#pf-result-lang').text(langLabel);
    updateResultKindBadge();

    if (data.isCustomSheet) {
        renderCustomResultBlock(data.fullText);
    } else {
        renderSectionCards(data.sections);
    }

    setEditMode(false);
    updateIncompleteBanner();

    $('#pf-regen-all-panel').hide();
    $('#pf-translate-panel').hide();
    $('#pf-modify-panel').hide();
    $('#pf-greeting-panel').hide();

    renderGreeting();
    renderSupport();
}

function updateResultKindBadge() {
    const kind = state.currentGeneration?.resultKind || 'original';
    $('#pf-result-kind')
        .attr('class', `pf-badge pf-badge-${kind}`)
        .text(RESULT_KIND_LABELS[kind] || '');
}

function updateIncompleteBanner() {
    const info = state.currentGeneration?.incomplete;
    const $banner = $('#pf-incomplete-banner');
    if (!info) {
        $banner.hide();
        return;
    }

    let message;
    if (info.reason === 'length') {
        message = '출력 한도(최대 출력 토큰)에 걸려 결과가 중간에 잘렸습니다.';
    } else if (info.kind === 'translate') {
        message = `원문 섹션 ${info.expected}개 중 ${info.actual}개만 번역되어, 뒷부분이 잘렸을 수 있습니다.`;
    } else if (info.kind === 'modify') {
        message = `섹션이 ${info.expected}개에서 ${info.actual}개로 줄었습니다. 의도한 삭제가 아니라면 뒷부분이 잘렸을 수 있습니다.`;
    } else {
        message = `요청한 섹션 ${info.expected}개 중 ${info.actual}개만 작성되어, 뒷부분이 잘렸을 수 있습니다.`;
    }
    $('#pf-incomplete-text').text(`${message} 설정 탭의 최대 출력 토큰을 늘린 뒤 다시 시도해 주십시오.`);
    $banner.show();
}

// 결과 제목·토큰 수 (생성·편집·재생성 뒤)
function refreshResultHeader(data = state.currentGeneration) {
    renderResultTitle(data);
    updateResultTokens(data);
}

function renderResultConcept(data = state.currentGeneration) {
    const concept = String(data?.conceptText || '').trim();
    const $box = $('#pf-result-concept');
    $box.toggle(!!concept).removeAttr('open');
    if (!concept) return;
    $('#pf-result-concept-preview').text(concept.replace(/\s+/g, ' '));
    $('#pf-result-concept-text').text(concept);
}

// 프로필 토큰 수 (그리팅 제외) — 실리태번 토크나이저 기준
async function updateResultTokens(data = state.currentGeneration) {
    const $badge = $('#pf-result-tokens');
    const text = data?.fullText || '';
    if (!text) return $badge.text('');
    const tokens = await countTokens(text);
    if (state.currentGeneration === data && data.fullText === text) $badge.text(`약 ${tokens.toLocaleString()}토큰`);
}

// 결과 제목 — 만든 인물의 이름과 참고한 캐릭터 (페르소나는 프로필에서 이름을 못 찾으면 참고한 캐릭터 이름)
function renderResultTitle(data = state.currentGeneration) {
    if (!data) return;
    const isBot = data.mode === 'bot';
    let name = data.charName;
    let note = isBot ? (data.refName ? `참고: ${data.refName}` : (data.wiNames?.length ? worldInfoNote(data.wiNames) : '')) : '';
    const made = isBot ? '' : guessProfileName(data.fullText);
    if (made) {
        name = made;
        note = data.noTarget ? worldInfoNote(data.wiNames) : `참고: ${data.charName}`;
    }
    if (data.templateId === 'manual') note = '직접 추가';
    const ref = note ? ` <span class="pf-result-ref">· ${escapeHtml(note)}</span>` : '';
    const icon = data.worldOnly ? 'fa-earth-asia' : (isBot ? 'fa-robot' : 'fa-user');
    $('#pf-result-char-name').html(`<i class="fa-solid ${icon}"></i> ${escapeHtml(name)}${ref}`);
}

const RULE_LINE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

function bodyDisplayHtml(text) {
    const lines = String(text || '').split('\n');
    const isEdge = line => RULE_LINE.test(line) || !line.trim();
    while (lines.length && isEdge(lines[0])) lines.shift();
    while (lines.length && isEdge(lines[lines.length - 1])) lines.pop();
    return lines.map(line => (RULE_LINE.test(line) ? '\u0000' : escapeHtml(line))).join('\n')
        .replace(/\n*\u0000\n*/g, '<hr class="pf-rule">');
}

// 섹션 카드 본문 HTML (자기 헤더만 빼고 표시 — ### 소제목은 유지)
function sectionBodyHtml(section) {
    const html = bodyDisplayHtml(getSectionBody(section));
    return html
        ? { html, isEmpty: false }
        : { html: '(이 섹션은 비어 있습니다. 재생성을 시도해 주십시오.)', isEmpty: true };
}

// "# 제목" 줄만 있는 섹션 (본문 없음) — 카드 대신 제목으로 표시
function isTitleOnly(section) {
    return /^#\s/.test(String(section?.header || '').trim()) && !bodyDisplayHtml(getSectionBody(section));
}

function hasOddStructure(sections) {
    const regular = Object.values(sections || {}).filter(section => section && !isTitleOnly(section));
    const empty = regular.filter(section => !bodyDisplayHtml(getSectionBody(section))).length;
    return !regular.length || (empty >= 2 && empty * 2 >= regular.length);
}

function headerLabelOf(section) {
    return headerLabel(section?.header);
}

function renderSectionCards(sections) {
    if (hasOddStructure(sections)) {
        renderCustomResultBlock(state.currentGeneration?.fullText || '', 'PROFILE');
        return;
    }
    const $container = $('#pf-sections-container');
    $container.empty();

    const sortedKeys = Object.keys(sections).sort((a, b) => {
        const numA = parseInt(a.replace('section_', ''), 10);
        const numB = parseInt(b.replace('section_', ''), 10);
        return numA - numB;
    });

    for (const sectionKey of sortedKeys) {
        const section = sections[sectionKey];
        if (!section) continue;

        const headerLabel = headerLabelOf(section);
        const icon = guessIconForHeader(headerLabel);
        const { html: bodyContent, isEmpty } = sectionBodyHtml(section);

        if (isTitleOnly(section)) {
            $container.append(`<div class="pf-profile-title" data-section-key="${sectionKey}">${escapeHtml(headerLabel)}</div>`);
            continue;
        }

        $container.append(`
        <div class="pf-section-card" data-section-key="${sectionKey}">
            <div class="pf-section-card-header">
                <span class="pf-section-icon"><i class="${icon}"></i></span>
                <span class="pf-section-label">${escapeHtml(headerLabel)}</span>
                <button class="pf-section-edit-btn" title="이 섹션 편집" data-section-key="${sectionKey}"><i class="fa-solid fa-pen"></i></button>
                <button class="pf-section-regen-btn" title="이 섹션 재생성" data-section-key="${sectionKey}"><i class="fa-solid fa-arrows-rotate"></i></button>
            </div>
            <div class="pf-section-card-body${isEmpty ? ' empty' : ''}">${bodyContent}</div>
            <div class="pf-section-regen-panel" style="display: none;">
                <textarea placeholder="이 섹션에 대한 수정 지시 (선택)...&#10;예: 더 짧게, 핵심만 남겨 줘&#10;예: 과거 사연을 좀 더 어둡게 바꿔 줘"></textarea>
                <div class="pf-section-regen-actions">
                    <button class="pf-section-regen-go pf-primary-btn pf-small-btn" data-section-key="${sectionKey}">재생성</button>
                    <button class="pf-section-regen-cancel pf-small-btn">취소</button>
                </div>
            </div>
        </div>`);
    }
}

function renderCustomResultBlock(fullText, label = 'CUSTOM PROFILE') {
    const $container = $('#pf-sections-container');
    $container.empty();

    $container.append(`
    <div class="pf-custom-result-block">
        <div class="pf-section-card">
            <div class="pf-section-card-header">
                <span class="pf-section-icon"><i class="fa-solid fa-file-lines"></i></span>
                <span class="pf-section-label">${escapeHtml(label)}</span>
            </div>
            <div class="pf-section-card-body">${bodyDisplayHtml(fullText)}</div>
        </div>
    </div>`);
}

async function onModifyClick() {
    if (warnIfBusy()) return;

    const instructions = $('#pf-modify-instructions').val() || '';
    if (!instructions.trim()) {
        showToast('warning', '수정 지시사항을 입력해 주십시오.');
        return;
    }

    try {
        showGenerateLoading(true, 'modify');
        $('#pf-modify-panel').hide();

        const result = await modifyProfile(instructions);

        renderGenerationResult(result);
        playGlint('.pf-result-toolbar');
        $('#pf-modify-instructions').val('');
        showToast('success', '프로필이 수정되었습니다!');
        playChime('done');
        autoSaveToHistory();

    } catch (error) {
        if (isCancelError(error)) return;
        logError('modify', error);
        playChime('error');
        showToast('error', `수정 실패: ${error.message}`);
        showGenerateLoading(false);
    }
}

function onSectionRegenToggle() {
    const $card = $(this).closest('.pf-section-card');
    const $panel = $card.find('.pf-section-regen-panel');

    const $editPanel = $card.find('.pf-section-edit-panel');
    if ($editPanel.length) {
        $editPanel.remove();
        $card.find('.pf-section-card-body').show();
    }

    $panel.toggle();
}

async function onSectionRegenClick() {
    if (warnIfBusy()) return;

    const sectionKey = $(this).data('section-key');
    const $card = $(`.pf-section-card[data-section-key="${sectionKey}"]`);
    const $body = $card.find('.pf-section-card-body');
    const instructions = $card.find('.pf-section-regen-panel textarea').val() || '';

    const restore = () => {
        const section = state.currentGeneration?.sections[sectionKey];
        if (!section) return;
        const { html, isEmpty } = sectionBodyHtml(section);
        $body.toggleClass('empty', isEmpty).html(html);
    };

    let ticker = null;
    try {
        $body.html('<div class="pf-section-loading"><div class="pf-spinner pf-spinner-small"></div><span class="pf-section-loading-text"></span></div>');
        ticker = startLoadingText($body.find('.pf-section-loading-text'), 'section');
        $card.find('.pf-section-regen-panel').hide();

        const { generation, truncated } = await regenerateSection(sectionKey, instructions);

        const section = generation.sections[sectionKey];
        restore();
        updateResultKindBadge();
        syncProfileToHistory(generation);
        $card.find('.pf-section-regen-panel textarea').val('');

        const headerLabel = headerLabelOf(section);
        if (headerLabel) {
            $card.find('.pf-section-label').text(headerLabel);
            $card.find('.pf-section-icon i').attr('class', guessIconForHeader(headerLabel));
        }

        if (truncated) {
            showToast('warning', `"${headerLabel}" 섹션이 출력 한도에 걸려 끝까지 작성되지 않았습니다. 최대 출력 토큰을 늘려 다시 시도하십시오.`);
        } else {
            refreshResultHeader();
            playGlint($card[0]);
            showToast('success', `"${headerLabel}" 섹션이 재생성되었습니다.`);
        }
        playChime('done');

    } catch (error) {
        restore();
        if (isCancelError(error)) return;
        logError('regenSection', error);
        playChime('error');
        showToast('error', `재생성 실패: ${error.message}`);
    } finally {
        stopLoadingText(ticker);
    }
}

function onSectionEditToggle() {
    const sectionKey = $(this).data('section-key');
    if (sectionKey === undefined) return; // 그리팅 카드의 버튼 (같은 모양 클래스)
    const $card = $(`.pf-section-card[data-section-key="${sectionKey}"]`);
    const $body = $card.find('.pf-section-card-body');
    const $existingEdit = $card.find('.pf-section-edit-panel');

    $card.find('.pf-section-regen-panel').hide();

    if ($existingEdit.length) {
        $existingEdit.remove();
        $body.show();
        return;
    }

    const section = state.currentGeneration?.sections[sectionKey];
    if (!section) return;
    const rawContent = getSectionBody(section);

    $body.hide();

    const editPanel = `
    <div class="pf-section-edit-panel">
        <textarea class="pf-section-edit-textarea pf-textarea">${escapeHtml(rawContent)}</textarea>
        <div class="pf-section-edit-actions">
            <button class="pf-section-edit-save pf-primary-btn pf-small-btn" data-section-key="${sectionKey}"><i class="fa-solid fa-check"></i> 저장</button>
            <button class="pf-section-edit-cancel pf-btn pf-small-btn" data-section-key="${sectionKey}">취소</button>
        </div>
    </div>`;

    $body.after(editPanel);
    fitToContent($card.find('.pf-section-edit-textarea')[0]);
}

function onSectionEditSave() {
    const sectionKey = $(this).data('section-key');
    const $card = $(`.pf-section-card[data-section-key="${sectionKey}"]`);
    const newText = $card.find('.pf-section-edit-textarea').val().trim();
    const section = state.currentGeneration?.sections[sectionKey];
    if (!section) return;

    setSectionBody(section, newText);
    rebuildFullText();
    markModified();
    updateResultKindBadge();

    $card.find('.pf-section-edit-panel').remove();
    const { html, isEmpty } = sectionBodyHtml(section);
    $card.find('.pf-section-card-body').html(html).toggleClass('empty', isEmpty).show();
    refreshResultHeader();
    syncProfileToHistory();
}

function onSectionEditCancel() {
    const sectionKey = $(this).data('section-key');
    const $card = $(`.pf-section-card[data-section-key="${sectionKey}"]`);
    $card.find('.pf-section-edit-panel').remove();
    $card.find('.pf-section-card-body').show();
}

async function onRegenAllClick() {
    if (warnIfBusy()) return;

    // 전체 재생성은 설정 탭의 현재 선택으로 다시 만들므로, 결과와 같은 모드일 때만
    const genMode = state.currentGeneration?.mode === 'bot' ? 'bot' : 'persona';
    if (genMode !== (isBotMode() ? 'bot' : 'persona')) {
        showToast('warning', `이 결과는 ${genMode === 'bot' ? '봇' : '페르소나'} 모드에서 만들었습니다. 위쪽에서 ${genMode === 'bot' ? '봇' : '페르소나'}로 바꾼 뒤 다시 시도하십시오.`);
        return;
    }

    const instructions = $('#pf-regen-all-instructions').val() || '';

    try {
        showGenerateLoading(true);
        $('#pf-regen-all-panel').hide();

        const result = await regenerateAll(instructions);

        renderGenerationResult(result);
        playGlint('.pf-result-toolbar');
        showToast('success', result.mode === 'bot' ? '봇 캐릭터를 새로 벼려냈습니다!' : '페르소나를 새로 벼려냈습니다!');
        countForged();
        playChime('done');
        autoSaveToHistory();

    } catch (error) {
        if (isCancelError(error)) return;
        logError('regenAll', error);
        playChime('error');
        showToast('error', `재생성 실패: ${error.message}`);
        showGenerateLoading(false);
    }
}

function setEditMode(enabled) {
    isEditMode = enabled;
    // toggle()은 비어 있던 목록을 block으로 되살려 카드 간격이 사라지므로 인라인 값만 지움
    $('#pf-sections-container').css('display', enabled ? 'none' : '');
    $('#pf-modify-section').toggle(!enabled);
    $('#pf-edit-area').toggle(enabled);
    $('#pf-edit-toggle-btn').html(enabled
        ? '<i class="fa-solid fa-eye"></i> 미리보기'
        : '<i class="fa-solid fa-pen"></i> 전체 편집');
}

async function toggleEditMode() {
    if (!isEditMode) {
        // 프로필 섹션 편집 칸만 닫음 (그리팅 카드의 편집 칸은 고정 요소라 지우면 안 됨)
        $('#pf-sections-container .pf-section-edit-panel').remove();
        $('#pf-sections-container .pf-section-card-body').show();

        $('#pf-edit-textarea').val(state.currentGeneration?.fullText || '');
        setEditMode(true);
        return;
    }

    const edited = $('#pf-edit-textarea').val() !== (state.currentGeneration?.fullText || '');
    if (edited && !(await askConfirm('적용하지 않은 편집 내용이 있습니다. 버리고 미리보기로 돌아가시겠습니까?'))) return;
    setEditMode(false);
}

function applyEdit() {
    const text = $('#pf-edit-textarea').val();
    const changed = text !== state.currentGeneration?.fullText;
    updateFromEditedText(text);
    setEditMode(false);
    refreshProfileView();
    if (changed) syncProfileToHistory();
}

// 프로필 글이 통째로 바뀐 뒤 (전체 편집·서포터 변경안 적용) 카드·배지·제목 다시 그리기
function refreshProfileView() {
    const gen = state.currentGeneration;
    if (!gen) return;
    if (gen.isCustomSheet) renderCustomResultBlock(gen.fullText);
    else renderSectionCards(gen.sections);
    updateResultKindBadge();
    refreshResultHeader();
}

async function onTranslateClick() {
    if (warnIfBusy()) return;

    const targetLang = $('#pf-translate-lang').val();

    try {
        showGenerateLoading(true, 'translate');
        $('#pf-translate-panel').hide();

        const result = await translateProfile(targetLang);

        renderGenerationResult(result);
        playGlint('.pf-result-toolbar');
        showToast('success', `${LANGUAGES[targetLang]?.label || targetLang}로 번역되었습니다!`);
        playChime('done');
        autoSaveToHistory();

    } catch (error) {
        if (isCancelError(error)) return;
        logError('translate', error);
        playChime('error');
        showToast('error', `번역 실패: ${error.message}`);
        showGenerateLoading(false);
    }
}

function updateGreetingLengthInput() {
    $('#pf-greeting-length-custom').toggle(getSettings()?.greetingLength === 'custom');
}

function greetingMetaText(greeting) {
    const parts = [];
    if (greeting.length === 'custom' && greeting.customLength) parts.push(greeting.customLength);
    else if (GREETING_LENGTHS[greeting.length]) parts.push(GREETING_LENGTHS[greeting.length].label);
    if (GREETING_POVS[greeting.pov]) parts.push(GREETING_POVS[greeting.pov].label);
    if (LANGUAGES[greeting.language]) parts.push(LANGUAGES[greeting.language].label);
    return parts.join(' · ');
}

// 그리팅 토큰 수 (프로필과 따로)
async function updateGreetingTokens(greeting) {
    const $badge = $('#pf-greeting-tokens');
    const text = greeting?.text || '';
    if (!text) return $badge.text('');
    const tokens = await countTokens(text);
    if (state.currentGeneration?.greeting === greeting) $badge.text(`약 ${tokens.toLocaleString()}토큰`);
}

function renderGreeting() {
    const gen = state.currentGeneration;
    const greeting = gen?.mode === 'bot' ? gen.greeting : null;
    const has = !!greeting?.text;
    $('#pf-greeting-loading').hide();
    $('#pf-greeting-edit-panel').hide();
    // 만들기 전에는 생성 버튼만, 만든 뒤에는 전체 편집·재생성·번역
    $('#pf-greeting-toggle-btn span').text(has ? '재생성' : '생성');
    $('#pf-greeting-edit, #pf-greeting-translate-btn').css('display', has ? '' : 'none');
    $('#pf-greeting-badges').css('display', has ? '' : 'none');
    $('#pf-greeting-modify').toggle(has);
    if (!has) {
        $('#pf-greeting-card, #pf-greeting-modify-panel, #pf-greeting-translate-panel').hide();
        return;
    }
    $('#pf-greeting-meta').text(greetingMetaText(greeting));
    updateGreetingTokens(greeting);
    $('#pf-greeting-body').text(greeting.text).show();
    const { index, total } = greetingPosition();
    $('#pf-greeting-pager').css('display', total > 1 ? '' : 'none');
    $('#pf-greeting-count').text(`${index + 1}/${total}`);
    $('#pf-greeting-prev').prop('disabled', index <= 0);
    $('#pf-greeting-next').prop('disabled', index >= total - 1);
    $('#pf-greeting-card').show();
}

// 만든 그리팅 버전 넘겨 보기 — 보고 있는 버전이 카드 저장·복사에 쓰임
function onGreetingSwipe(step) {
    if (!selectGreeting(step)) return;
    $('#pf-greeting-edit-panel').hide();
    renderGreeting();
    syncGreetingSoon();
}

const syncGreetingSoon = debounce(() => syncGreetingToHistory(), 600);

function openGreetingPanel() {
    const gen = state.currentGeneration;
    if (!gen?.fullText) return;
    const $panel = $('#pf-greeting-panel');
    if ($panel.is(':visible')) {
        $panel.hide();
        return;
    }
    $('#pf-greeting-translate-panel, #pf-greeting-modify-panel').hide();
    const language = gen.greeting?.language || gen.language || getSettings().language || 'en';
    $('#pf-greeting-lang').val(LANGUAGES[language] ? language : 'en');
    if (gen.greeting?.concept && !$('#pf-greeting-concept').val()) {
        $('#pf-greeting-concept').val(gen.greeting.concept);
    }
    $panel.show();
}

function openGreetingTranslatePanel() {
    const greeting = state.currentGeneration?.greeting;
    const $panel = $('#pf-greeting-translate-panel');
    if (!greeting?.text || $panel.is(':visible')) {
        $panel.hide();
        return;
    }
    $('#pf-greeting-panel, #pf-greeting-modify-panel').hide();
    // 기본 대상: 출력 언어 (그리팅이 이미 그 언어면 영어·한국어 중 다른 쪽)
    const current = greeting.language || state.currentGeneration.language || 'en';
    const preferred = getSettings().language || 'en';
    $('#pf-greeting-translate-lang').val(preferred !== current ? preferred : (current === 'en' ? 'ko' : 'en'));
    $panel.show();
}

async function onGreetingTranslate() {
    if (warnIfBusy()) return;
    const gen = state.currentGeneration;
    const targetLang = String($('#pf-greeting-translate-lang').val() || '');
    if ((gen?.greeting?.language || gen?.language) === targetLang) {
        showToast('warning', '지금 그리팅과 같은 언어입니다. 다른 언어를 골라 주십시오.');
        return;
    }

    $('#pf-greeting-translate-panel').hide();
    $('#pf-greeting-card').hide();
    $('#pf-greeting-modify').hide();
    $('#pf-greeting-loading').css('display', 'flex');
    const ticker = startLoadingText('#pf-greeting-loading-text', 'greetingTranslate');
    startProgress('#pf-greeting-progress');

    try {
        const greeting = await translateGreeting(targetLang);
        if (state.currentGeneration !== gen) return;
        renderGreeting();
        if (!greeting.truncated) playGlint('#pf-greeting-card');
        showToast(greeting.truncated ? 'warning' : 'success', greeting.truncated
            ? '번역한 그리팅이 출력 한도에 걸려 끝까지 작성되지 않았습니다. 최대 출력 토큰을 늘려 다시 시도하십시오.'
            : `그리팅을 ${LANGUAGES[targetLang]?.label || targetLang}로 번역했습니다! (새 버전으로 추가)`);
        playChime('done');
        syncGreetingToHistory();
    } catch (error) {
        if (state.currentGeneration === gen) renderGreeting();
        if (isCancelError(error)) return;
        logError('greetingTranslate', error);
        playChime('error');
        showToast('error', `그리팅 번역 실패: ${error.message}`);
    } finally {
        stopLoadingText(ticker);
        stopProgress('#pf-greeting-progress');
    }
}

// ===== 대화형 서포터 — 결과 아래 대화창 =====
// 대화는 결과마다 따로 (gen.supportChat), 기록 자동 저장이 켜져 있으면 그 기록에 함께 저장
// 이름·부를 이름·성별·프로필 이미지는 설정에 있어 모든 결과의 대화에 똑같이 적용

let supportController = null; // 답을 기다리는 동안의 취소 장치
let supportPendingGen = null; // 답을 기다리는 결과 (그사이 다른 결과를 불러와도 답은 원래 결과의 대화로)
let supportRenderedCount = 0; // 새로 붙은 말풍선만 움직이게
let pendingAvatarFace = 'neutral'; // 이미지를 올릴 표정 칸
let supportRegenTarget = null; // 다시 받는 중인 마지막 답 (그동안 화면에서 가리고 점 세 개)
let supportSwiped = false; // 버전을 넘길 때 마지막 답만 살짝 움직이게
let supportTouch = null;
const SUPPORT_LOG_ROOM = 100; // 대화창 아래 입력칸·여백 몫
// 긴 대화는 최근 티키타카 5쌍(내 말 + 답, 메시지 10개)부터 보여 주고, 위쪽 "이전 대화 더 보기"로 5쌍씩 더
const SUPPORT_PAGE_ROUNDS = 5;
let supportShowFrom = 0; // 화면에 그리는 첫 메시지 번호
let supportPageGen = null; // 위 번호를 정한 결과 (다른 결과를 불러오면 다시 최근부터)
// 답(버전) → Map(변경안 번호 → 되돌리기 정보) — 바로 적용한 변경안 (화면에만 표시, 기록에는 저장 안 함)
const supportApplied = new WeakMap();

const SUPPORT_OPENERS = [
    '오, 새로 벼린 거예요? 어디부터 같이 볼까요?',
    '깡! 작업대 비워 뒀어요. 뭐부터 얘기해 볼까요?',
    '왔어요? 이번 건 어디가 제일 신경 쓰여요?',
    '따끈따끈하네요. 마음에 걸리는 데 있으면 말해 줘요.',
];

function supportChat() {
    const gen = state.currentGeneration;
    if (!gen) return [];
    if (!Array.isArray(gen.supportChat)) gen.supportChat = [];
    return gen.supportChat;
}

// 처음 열 때 캐릭터의 첫 인사 (화면에만 있는 말 — API로는 보내지 않음)
function ensureSupportOpener() {
    const gen = state.currentGeneration;
    const chat = supportChat();
    if (chat.length || !gen) return;
    gen.supportGender ||= supporterGenderKey(); // 이 대화의 성별 — 새 대화는 마지막에 고른 성별로 시작
    chat.push({ role: 'assistant', local: true, opener: Math.floor(Math.random() * SUPPORT_OPENERS.length), face: 'smile' });
}

// 첫 인사는 보여 줄 때 부를 이름을 붙임 (나중에 이름을 바꿔도 맞게)
function supportMessageText(message) {
    if (!message?.local || !Number.isInteger(message.opener)) return message?.text || '';
    const line = SUPPORT_OPENERS[message.opener] || SUPPORT_OPENERS[0];
    const address = String(getSettings()?.supporterUserName || '').trim();
    return address ? `${address}, ${line}` : line;
}

// 지금 대화 상대의 이름 (쌍둥이 — 여성 모루윈 / 남성 모루안)
function currentSupporterName() {
    return supporterName(supporterGenderKey());
}

// 지금 대화의 성별 (대화마다 처음 정한 성별 그대로, 예전 대화는 설정의 성별)
function supporterGenderKey() {
    const gender = state.currentGeneration?.supportGender || getSettings()?.supporterGender;
    return gender === 'male' ? 'male' : 'female';
}

// 직접 올린 이미지가 있으면 그 묶음에서 (그 표정 → 기본 표정 → 아무거나),
// 없으면 기본 이미지에서 (그 표정 → 기본 표정), 그것도 없으면 아이콘
function supportAvatarUrl(face = 'neutral') {
    const key = supporterGenderKey();
    const custom = getSettings()?.supporterAvatars?.[key] || {};
    const own = Object.values(custom).find(Boolean);
    if (own) return custom[face] || custom.neutral || own;
    return SUPPORTER_AVATARS[key]?.[face] || SUPPORTER_AVATARS[key]?.neutral || '';
}

// 직접 올린 이미지(data URL, 수십 KB)는 한 번만 blob 주소로 바꿔 씀 — 말풍선마다 긴 글자열을 다시 넣지 않게
const avatarObjectUrls = new Map();
function avatarDisplayUrl(url) {
    if (!url.startsWith('data:')) return url;
    if (!avatarObjectUrls.has(url)) {
        try {
            const [head, body] = url.split(',');
            const bytes = Uint8Array.from(atob(body), c => c.charCodeAt(0));
            avatarObjectUrls.set(url, URL.createObjectURL(new Blob([bytes], { type: head.match(/data:([^;]+)/)?.[1] || 'image/webp' })));
        } catch {
            return url;
        }
    }
    return avatarObjectUrls.get(url);
}

// 지운·바꾼 이미지의 blob 주소 정리
function releaseAvatarUrls() {
    const inUse = new Set(Object.values(getSettings()?.supporterAvatars || {}).flatMap(set => Object.values(set || {})));
    for (const [dataUrl, objectUrl] of avatarObjectUrls) {
        if (inUse.has(dataUrl)) continue;
        URL.revokeObjectURL(objectUrl);
        avatarObjectUrls.delete(dataUrl);
    }
}

function avatarImgHtml(url) {
    return `<img src="${escapeHtml(avatarDisplayUrl(url))}" alt="">`;
}

function supportAvatarHtml(face) {
    const url = supportAvatarUrl(face);
    return url ? avatarImgHtml(url) : '<i class="fa-solid fa-hammer"></i>';
}

// 올린 이미지를 정사각형 256px로 줄여 저장 (작게 보여도 선명하고, 설정 파일은 가볍게)
// 세로로 긴 그림은 얼굴이 보통 위쪽에 있으므로 위쪽 기준으로 자름 (가로로 길면 가운데)
function resizeAvatar(file, size = 256) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            const width = image.naturalWidth;
            const height = image.naturalHeight;
            const side = Math.min(width, height);
            const x = (width - side) / 2;
            const y = Math.min((height - side) * 0.15, side * 0.08);
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = Math.min(size, side);
            const context = canvas.getContext('2d');
            context.imageSmoothingQuality = 'high';
            context.drawImage(image, x, y, side, side, 0, 0, canvas.width, canvas.height);
            const webp = canvas.toDataURL('image/webp', 0.86);
            resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88));
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('이미지를 읽지 못했습니다.'));
        };
        image.src = url;
    });
}

function setSupportAvatar(face, url) {
    if (!SUPPORTER_FACES.some(item => item.id === face)) return;
    const key = supporterGenderKey();
    const avatars = getSettings().supporterAvatars || {};
    const set = { ...(avatars[key] || {}) };
    if (url) set[face] = url;
    else delete set[face];
    updateSetting('supporterAvatars', { ...avatars, [key]: set });
    releaseAvatarUrls();
    renderSupportIdentity();
    renderSupportLog({ scroll: 'stay' });
}

async function onSupportAvatarFile() {
    const file = this.files?.[0];
    this.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        showToast('warning', '이미지 파일을 골라 주십시오.');
        return;
    }
    try {
        setSupportAvatar(pendingAvatarFace, await resizeAvatar(file));
    } catch (error) {
        showToast('error', error.message);
    }
}

function onSupportAvatarRemove() {
    setSupportAvatar(String($(this).attr('data-face') || ''), '');
}

// 이름·성별·프로필 이미지 (설정 탭·대화창 곳곳)
function renderSupportIdentity() {
    const settings = getSettings();
    const key = supporterGenderKey();
    const name = currentSupporterName();
    $('#pf-support-title').text(`${name}${josa(name, '과', '와')} 이야기하기`);
    // 대화 상대 버튼 — 버튼 안에 span을 또 넣으면 버튼 모양이 겹쳐 그려지므로 글자만 바꿈
    $('.pf-supporter-pill[data-gender="female"]').text(`${supporterName('female')} (여성)`);
    $('.pf-supporter-pill[data-gender="male"]').text(`${supporterName('male')} (남성)`);
    $('#pf-support-toggle .pf-support-avatar').html(supportAvatarHtml());
    const custom = settings?.supporterAvatars?.[key] || {};
    $('#pf-support-faces').html(SUPPORTER_FACES.map(face => {
        const own = custom[face.id];
        const url = own || SUPPORTER_AVATARS[key]?.[face.id];
        return `
            <div class="pf-support-face">
                <button class="pf-support-face-pick" type="button" data-face="${face.id}" title="${face.label} 표정 이미지 올리기">
                    <span class="pf-support-avatar${url ? '' : ' pf-support-face-empty'}">${url ? avatarImgHtml(url) : '<i class="fa-solid fa-plus"></i>'}</span>
                    <span class="pf-support-face-label">${face.label}</span>
                </button>
                ${own ? `<button class="pf-support-face-remove" type="button" data-face="${face.id}" title="이 이미지 지우기"><i class="fa-solid fa-xmark"></i></button>` : ''}
            </div>`;
    }).join(''));
    $('#pf-support-username').val(settings?.supporterUserName || '');
    $(`input[name="pf-support-user-gender"][value="${settings?.supporterUserGender || ''}"]`).prop('checked', true);
    if (!$('#pf-support-userintro').is(':focus')) $('#pf-support-userintro').val(settings?.supporterUserIntro || '');
    $(`input[name="pf-supporter-gender"][value="${key}"]`).prop('checked', true);
}

// "모루가 보는 것" — 대화 맨 위(스크롤 안)에 한 번만, 내리면 함께 올라가 가려짐
function supportKnowsHtml() {
    const items = describeSupportMaterial();
    if (!items.length) return '';
    const name = currentSupporterName();
    return `
        <div class="pf-support-knows">
            <span>${escapeHtml(`${name}${josa(name, '이', '가')} 보는 것: ${items.join(' · ')}`)}</span>
            <span class="pf-support-knows-note">결과를 고치거나 다시 만들면, 다음 메시지부터 바뀐 내용을 봅니다.</span>
        </div>`;
}

function renderSupport() {
    renderSupportIdentity();
    const open = $('#pf-support-toggle').attr('aria-expanded') === 'true';
    if (!open) return;
    ensureSupportOpener();
    renderSupportLog();
}

// 대화창 위아래 끝의 옅은 그라데이션 — 그쪽으로 더 스크롤할 내용이 있을 때만
function updateSupportFade() {
    const log = document.getElementById('pf-support-log');
    if (!log) return;
    const rest = log.scrollHeight - log.clientHeight - log.scrollTop;
    log.classList.toggle('pf-fade-top', log.scrollTop > 2);
    log.classList.toggle('pf-fade-bottom', rest > 2);
}

function toggleSupport() {
    const $toggle = $('#pf-support-toggle');
    const open = $toggle.attr('aria-expanded') !== 'true';
    $toggle.attr('aria-expanded', String(open));
    $('#pf-support').toggleClass('pf-open', open);
    $('#pf-support-body').css('display', open ? '' : 'none');
    if (open) fitSupportLogHeight();
    supportRenderedCount = open ? supportChat().length + 1 : 0; // 펼칠 때는 전부 한 번에 (움직임 없이)
    supportPageGen = null; // 펼칠 때마다 최근 티키타카부터
    renderSupport();
    if (open) scrollSupportToEnd();
}

// 대화창 높이 — 확장 창에서 보이는 높이에 맞춤 (끝까지 내리면 머리줄은 위로 가려지고, 대화와 입력칸이 한 화면에)
function fitSupportLogHeight() {
    const body = document.querySelector('#persona-forge-popup .pf-body');
    const section = document.getElementById('pf-support');
    if (!body?.clientHeight || !section) return;
    section.style.setProperty('--pf-support-log-max', `${Math.max(260, body.clientHeight - SUPPORT_LOG_ROOM)}px`);
}

function scrollSupportToEnd() {
    const log = document.getElementById('pf-support-log');
    if (log) log.scrollTop = log.scrollHeight;
    updateSupportFade();
}

// 입력칸은 내용에 맞춰 늘어나되 몇 줄까지만
function growSupportInput(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 140)}px`;
}

// 모델 답을 글과 변경안(<edit>)으로 나눔 — 형식이 틀리면 전부 글로 보여 줌
function parseSupportText(text) {
    const parts = [];
    const pattern = /<edit\b([^>]*)>([\s\S]*?)<\/edit>/gi;
    let last = 0;
    let match;
    const tag = (body, name) => body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))?.[1]?.trim() || '';
    while ((match = pattern.exec(text))) {
        const revised = tag(match[2], 'revised');
        if (!revised) continue;
        if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) });
        parts.push({
            type: 'edit',
            target: match[1].match(/target\s*=\s*"([^"]*)"/i)?.[1]?.trim() || '',
            original: tag(match[2], 'original'),
            revised,
            revisedKo: tag(match[2], 'revised_ko'),
        });
        last = pattern.lastIndex;
    }
    if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
    return parts.map(part => (part.type === 'text' ? { ...part, text: part.text.trim() } : part))
        .filter(part => part.type !== 'text' || part.text);
}

// 변경안 카드의 글 — 원래 모양 그대로 (줄 앞 공백·들여쓰기도 살림, CSS pre-wrap)
function supportTextHtml(text) {
    return escapeHtml(text);
}

// 말풍선의 글 — 간단한 마크다운만 보기 좋게 (굵게·기울임·취소선·코드·제목 줄), 나머지는 글 그대로
function supportMarkdownHtml(text) {
    const inline = line => line
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(?=\S)(.*?\S)\*\*/g, '<strong>$1</strong>')
        .replace(/__(?=\S)(.*?\S)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/~~(?=\S)(.*?\S)~~/g, '<del>$1</del>');
    return escapeHtml(text).split('\n').map(line => {
        const heading = line.match(/^#{1,6}\s+(.+)$/);
        return heading ? `<strong>${inline(heading[1])}</strong>` : inline(line);
    }).join('\n');
}

// 다시 받은 답은 버전으로 쌓임 (마지막 답만) — message.text·face는 지금 고른 버전
function supportVersion(message) {
    return Array.isArray(message?.swipes) ? message.swipes[message.swipe] || message : message;
}

function selectSupportSwipe(message, index) {
    const version = message.swipes[index];
    message.swipe = index;
    message.text = version.text;
    message.face = version.face;
}

function addSupportSwipe(message, reply) {
    if (!Array.isArray(message.swipes)) {
        const first = { text: message.text, face: message.face };
        if (supportApplied.has(message)) supportApplied.set(first, supportApplied.get(message));
        message.swipes = [first];
    }
    message.swipes.push({ text: reply.text || '(빈 답이 왔습니다)', face: reply.face });
    selectSupportSwipe(message, message.swipes.length - 1);
}

// 대화가 넘어가면 고른 버전만 남김
function collapseSupportSwipes(message) {
    if (!Array.isArray(message?.swipes)) return;
    const version = supportVersion(message);
    if (supportApplied.has(version)) supportApplied.set(message, supportApplied.get(version));
    delete message.swipes;
    delete message.swipe;
}

function stepSupportSwipe(step) {
    if (supportController) return;
    const message = supportChat().at(-1);
    if (message?.role !== 'assistant' || !(message.swipes?.length > 1)) return;
    const next = (message.swipe ?? message.swipes.length - 1) + step;
    if (next < 0 || next >= message.swipes.length) return;
    selectSupportSwipe(message, next);
    supportSwiped = true;
    renderSupportLog({ scroll: 'stay' });
    saveSupportChatSoon();
}

// 바로 적용 버튼은 마지막 답의 변경안에만 (대화가 넘어가면 사라짐), 적용한 변경안은 "적용됨"으로 남음
function supportEditStatus(message, index, editIndex, edit) {
    const applied = supportApplied.get(supportVersion(message));
    if (applied?.has(editIndex)) return canUndoSupportEdit(applied.get(editIndex)) ? 'undo' : 'applied';
    const latest = index === supportChat().length - 1 && !supportController;
    return latest && edit.original ? 'ready' : '';
}

function supportEditHtml(edit, index, editIndex, status) {
    const ids = `data-message="${index}" data-edit="${editIndex}"`;
    const original = edit.original ? `
        <details class="pf-support-edit-original">
            <summary><i class="fa-solid fa-chevron-right"></i> 원문 보기</summary>
            <div class="pf-support-edit-box pf-support-edit-old">${supportTextHtml(edit.original)}</div>
        </details>` : '';
    const korean = edit.revisedKo ? `
        <div class="pf-support-edit-label">한국어</div>
        <div class="pf-support-edit-box pf-support-edit-ko">${supportTextHtml(edit.revisedKo)}</div>` : '';
    const applied = '<span class="pf-support-applied"><i class="fa-solid fa-check"></i> 적용됨</span>';
    const foot = {
        ready: `<button class="pf-support-apply pf-btn pf-small-btn" type="button" ${ids}><i class="fa-solid fa-hammer"></i> 바로 적용</button>`,
        applied,
        undo: `${applied}<button class="pf-support-undo pf-btn pf-small-btn" type="button" ${ids}><i class="fa-solid fa-rotate-left"></i> 되돌리기</button>`,
    }[status] || '';
    return `
        <div class="pf-support-edit${status === 'applied' || status === 'undo' ? ' pf-support-edit-done' : ''}">
            <div class="pf-support-edit-head">
                <span class="pf-support-edit-title"><i class="fa-solid fa-pen-ruler"></i> 변경안${edit.target ? `<span class="pf-support-edit-target">${escapeHtml(edit.target)}</span>` : ''}</span>
                <button class="pf-support-edit-copy" type="button" ${ids} title="대체안 복사"><i class="fa-regular fa-copy"></i></button>
            </div>
            ${original}
            <div class="pf-support-edit-label">대체안</div>
            <div class="pf-support-edit-box pf-support-edit-new">${supportTextHtml(edit.revised)}</div>
            ${korean}
            ${foot ? `<div class="pf-support-edit-foot">${foot}</div>` : ''}
        </div>`;
}

// 서포터 쪽: 프로필 이미지(답마다 그 답의 표정) + 이어지는 답의 첫 번째에만 이름
function supportTheirsHtml({ face, showName, isNew, swipeable, body }) {
    return `
        <div class="pf-support-msg pf-support-theirs${isNew ? ' pf-support-new' : ''}${swipeable ? ' pf-support-swipeable' : ''}">
            <span class="pf-support-avatar pf-support-avatar-chat" aria-hidden="true">${supportAvatarHtml(face)}</span>
            <div class="pf-support-stack">
                ${showName ? `<span class="pf-support-name">${escapeHtml(currentSupporterName())}</span>` : ''}
                ${body}
            </div>
        </div>`;
}

// from 앞쪽으로 내 말을 rounds개 거슬러 올라간 위치 (그보다 적으면 처음부터)
function supportPageStart(chat, from, rounds = SUPPORT_PAGE_ROUNDS) {
    let seen = 0;
    for (let index = from - 1; index > 0; index--) {
        if (chat[index].role === 'user' && ++seen === rounds) return index;
    }
    return 0;
}

// 이전 대화 더 보기 — 보고 있던 자리가 밀리지 않게 아래에서의 거리를 유지
function onSupportMore() {
    supportShowFrom = supportPageStart(supportChat(), supportShowFrom);
    renderSupportLog({ scroll: 'prepend' });
}

// scroll: end (맨 아래로 — 새 메시지·처음 펼칠 때) | stay (그 자리 그대로) | prepend (위에 더 붙였을 때)
function renderSupportLog({ scroll = 'end' } = {}) {
    const chat = supportChat();
    const log = document.getElementById('pf-support-log');
    const before = log ? { top: log.scrollTop, fromBottom: log.scrollHeight - log.scrollTop } : null;
    if (supportPageGen !== state.currentGeneration) {
        supportPageGen = state.currentGeneration;
        supportShowFrom = supportPageStart(chat, chat.length);
    }
    // 대화 중에는 보이는 범위가 늘어나기만 함 (지우면 번호가 당겨지므로 범위 안으로)
    supportShowFrom = Math.max(0, Math.min(supportShowFrom, chat.length - 1));
    const hidden = chat.slice(0, supportShowFrom).filter(message => !message.local).length;
    const lastIndex = chat.length - 1;
    let prevRole = '';
    const html = chat.map((message, index) => {
        if (index < supportShowFrom || message === supportRegenTarget) return '';
        const mine = message.role === 'user';
        const showName = !mine && prevRole !== 'assistant';
        prevRole = message.role;
        const isNew = index >= supportRenderedCount || (supportSwiped && index === lastIndex);
        const text = supportMessageText(message);
        const last = index === lastIndex && !supportController;
        const swipes = !mine && last && message.swipes?.length > 1 ? message.swipes : null;
        const current = swipes ? (message.swipe ?? swipes.length - 1) : 0;
        const actions = [
            swipes ? `
                <span class="pf-support-swipes">
                    <button class="pf-support-swipe-prev" title="이전 답"${current === 0 ? ' disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
                    <span>${current + 1}/${swipes.length}</span>
                    <button class="pf-support-swipe-next" title="다음 답"${current === swipes.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
                </span>` : '',
            !mine ? `<button class="pf-support-copy" data-index="${index}" title="복사"><i class="fa-regular fa-copy"></i></button>` : '',
            !mine && !message.local && last
                ? `<button class="pf-support-regen" data-index="${index}" title="다시 답하기 (이전 답도 남아 좌우로 넘겨 볼 수 있습니다)"><i class="fa-solid fa-arrows-rotate"></i></button>` : '',
            !message.local ? `<button class="pf-support-delete" data-index="${index}" title="지우기"><i class="fa-solid fa-trash-can"></i></button>` : '',
        ].join('');
        const parts = mine ? [{ type: 'text', text }] : parseSupportText(text);
        let editIndex = -1;
        const items = parts.map(part => {
            if (part.type !== 'edit') return `<div class="pf-support-bubble">${mine ? escapeHtml(part.text) : supportMarkdownHtml(part.text)}</div>`;
            editIndex++;
            return supportEditHtml(part, index, editIndex, supportEditStatus(message, index, editIndex, part));
        }).join('');
        const body = `<div class="pf-support-group">${items}</div>${actions ? `<div class="pf-support-actions">${actions}</div>` : ''}`;
        if (!mine) return supportTheirsHtml({ face: message.face, showName, isNew, swipeable: !!swipes, body });
        return `
            <div class="pf-support-msg pf-support-mine${isNew ? ' pf-support-new' : ''}">
                <div class="pf-support-stack">${body}</div>
            </div>`;
    }).join('');
    const typing = supportController && supportPendingGen === state.currentGeneration ? supportTheirsHtml({
        showName: prevRole !== 'assistant', isNew: true,
        body: '<div class="pf-support-group"><div class="pf-support-bubble pf-support-typing"><span></span><span></span><span></span></div></div>',
    }) : '';
    const more = hidden
        ? `<button class="pf-support-more" type="button"><i class="fa-solid fa-chevron-up"></i> 이전 대화 더 보기 <span>(메시지 ${hidden}개)</span></button>` : '';
    $('#pf-support-log').html(supportKnowsHtml() + more + html + typing);
    supportRenderedCount = chat.length;
    supportSwiped = false;
    $('#pf-support-send')
        .attr('title', supportController ? '답 기다리기 취소' : '보내기')
        .html(supportController ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-paper-plane"></i>');
    if (scroll === 'end' || !log || !before) scrollSupportToEnd();
    else if (scroll === 'prepend') log.scrollTop = log.scrollHeight - before.fromBottom;
    else log.scrollTop = before.top;
    updateSupportFade();
}

// 첫 인사만 있는 대화는 저장하지 않음
function supportChatForSave(chat) {
    return Array.isArray(chat) && chat.some(message => !message.local) ? chat : '';
}

// 기록 자동 저장 — 바뀐 결과를 모아 두었다가 잠시 뒤 한 번에 (그사이 다른 결과를 불러와도 원래 기록에)
const pendingSupportSaves = new Set();
const flushSupportSaves = debounce(async () => {
    const gens = [...pendingSupportSaves];
    pendingSupportSaves.clear();
    if (!getSettings().autoSaveHistory) return;
    for (const gen of gens) {
        if (!gen.historyId) continue;
        try {
            // 대화 파일만 다시 씀 (기록 전체 파일은 건드리지 않음)
            await saveSupportChat(gen.historyId, supportChatForSave(gen.supportChat) || null, gen.supportGender);
        } catch (error) {
            logError('saveSupportChat', error);
        }
    }
}, 800);

function saveSupportChatSoon(gen = state.currentGeneration) {
    if (!gen) return;
    pendingSupportSaves.add(gen);
    flushSupportSaves();
}

// regen: 다시 받을 마지막 답 — 새 답은 그 답의 새 버전으로 쌓임 (모델에는 그 답을 빼고 보냄)
async function requestSupportReply(regen = null) {
    const gen = state.currentGeneration;
    const chat = supportChat();
    supportController = new AbortController();
    supportPendingGen = gen;
    supportRegenTarget = regen;
    renderSupportLog();
    try {
        const reply = await sendSupportMessage(chat.filter(m => !m.local && m !== regen), { signal: supportController.signal });
        // 그사이 다른 결과를 불러왔어도 답은 원래 결과의 대화에 붙여 저장
        if (regen) {
            addSupportSwipe(regen, reply);
            supportSwiped = true;
        } else {
            chat.push({ role: 'assistant', text: reply.text || '(빈 답이 왔습니다)', face: reply.face });
        }
    } catch (error) {
        if (!isCancelError(error)) {
            logError('support', error);
            showToast('error', `${currentSupporterName()}의 답을 받지 못했습니다: ${error.message}`);
        }
    } finally {
        supportController = null;
        supportPendingGen = null;
        supportRegenTarget = null;
        renderSupportLog();
        saveSupportChatSoon(gen);
    }
}

function onSupportSend() {
    if (supportController) {
        supportController.abort();
        return;
    }
    if (state.isGenerating) {
        showToast('warning', '생성이 끝난 뒤에 이야기할 수 있습니다.');
        return;
    }
    const $input = $('#pf-support-text');
    const text = String($input.val() || '').trim();
    if (!text || !state.currentGeneration?.fullText) return;
    const chat = supportChat();
    collapseSupportSwipes(chat.at(-1));
    chat.push({ role: 'user', text });
    $input.val('');
    growSupportInput($input[0]);
    requestSupportReply();
}

// 마지막 답만 다시 받기 (앞의 대화는 그대로, 이전 답은 버전으로 남아 좌우로 넘겨 봄)
function onSupportRegenerate() {
    if (supportController || state.isGenerating) return;
    const chat = supportChat();
    const index = Number($(this).attr('data-index'));
    if (index !== chat.length - 1 || chat[index]?.role !== 'assistant' || chat[index].local) return;
    requestSupportReply(chat[index]);
}

function onSupportDelete() {
    if (supportController) return;
    const chat = supportChat();
    const index = Number($(this).attr('data-index'));
    if (!chat[index] || chat[index].local) return;
    chat.splice(index, 1);
    supportRenderedCount = chat.length;
    renderSupportLog({ scroll: 'stay' });
    saveSupportChatSoon();
}

async function onSupportCopy() {
    const message = supportChat()[Number($(this).attr('data-index'))];
    if (!message) return;
    const success = await copyToClipboard(supportMessageText(message));
    showToast(success ? 'success' : 'error', success ? '복사했습니다.' : '복사에 실패했습니다.');
}

async function onSupportClear() {
    if (supportController || !state.currentGeneration) return;
    if (!(await askConfirm('대화를 모두 지우시겠습니까?'))) return;
    state.currentGeneration.supportChat = [];
    supportRenderedCount = 0;
    supportPageGen = null;
    ensureSupportOpener();
    renderSupportLog();
    saveSupportChatSoon();
}

// 변경안 카드의 버튼 → 그 메시지와 변경안
function supportEditAt(button) {
    const message = supportChat()[Number($(button).attr('data-message'))];
    const editIndex = Number($(button).attr('data-edit'));
    const edit = message ? parseSupportText(supportMessageText(message)).filter(part => part.type === 'edit')[editIndex] : null;
    return { message, editIndex, edit };
}

async function onSupportEditCopy() {
    const { edit } = supportEditAt(this);
    if (!edit) return;
    const success = await copyToClipboard(edit.revised);
    showToast(success ? 'success' : 'error', success ? '대체안을 복사했습니다.' : '복사에 실패했습니다.');
}

function refreshAfterSupportEdit(kind) {
    if (kind === 'greeting') {
        renderGreeting();
        syncGreetingToHistory();
    } else {
        refreshProfileView();
        syncProfileToHistory();
    }
    renderSupportLog({ scroll: 'stay' });
}

// 바로 적용 — API 호출 없이 원문을 대체안으로 바꿈 (그리팅은 새 버전으로 추가)
function onSupportApply() {
    if (warnIfBusy()) return;
    const { message, editIndex, edit } = supportEditAt(this);
    if (!edit) return;
    if (isEditMode || $('#pf-sections-container .pf-section-edit-panel').length || $('#pf-greeting-edit-panel').is(':visible')) {
        showToast('warning', '열려 있는 편집 칸을 저장하거나 닫은 뒤에 적용하십시오.');
        return;
    }
    let info;
    try {
        info = applySupportEdit(edit);
    } catch (error) {
        showToast('warning', error.message);
        return;
    }
    const version = supportVersion(message);
    if (!supportApplied.has(version)) supportApplied.set(version, new Map());
    supportApplied.get(version).set(editIndex, info);
    refreshAfterSupportEdit(info.kind);
    showToast('success', info.kind === 'greeting' ? '그리팅에 적용했습니다. (새 버전으로 추가)' : '프로필에 적용했습니다.');
}

// 적용한 뒤로 그 글(프로필 또는 지금 그리팅 버전)이 그대로일 때만
function onSupportUndo() {
    if (warnIfBusy()) return;
    const { message, editIndex } = supportEditAt(this);
    const applied = supportApplied.get(supportVersion(message));
    const info = applied?.get(editIndex);
    if (!info) return;
    if (!undoSupportEdit(info)) {
        showToast('warning', '적용한 뒤로 결과가 바뀌어 되돌릴 수 없습니다.');
        renderSupportLog({ scroll: 'stay' });
        return;
    }
    applied.delete(editIndex);
    refreshAfterSupportEdit(info.kind);
    showToast('info', '적용을 되돌렸습니다.');
}

// 결과를 제자리에서 고친 뒤 (직접 편집·섹션 재생성·서포터 바로 적용·되돌리기) 지금 기록에도 반영
// — 안 하면 기록을 다시 불러왔을 때 고치기 전 글로 돌아감
async function syncProfileToHistory(gen = state.currentGeneration) {
    if (!getSettings().autoSaveHistory || !gen?.fullText) return;
    try {
        const found = gen.historyId && await updateHistory(gen.historyId, {
            fullText: gen.fullText,
            kind: gen.resultKind || 'original',
        });
        // 기록이 지워졌으면 새로 저장 (그사이 다른 결과를 불러왔으면 건너뜀)
        if (!found && gen === state.currentGeneration) gen.historyId = await addHistory(historyEntryFromCurrent(defaultHistoryName()));
        updateHistoryUI();
    } catch (error) {
        logError('syncProfileToHistory', error);
        showToast('error', `기록 자동 저장 실패: ${error.message}`);
    }
}

async function syncGreetingToHistory() {
    const gen = state.currentGeneration;
    if (!getSettings().autoSaveHistory || !gen) return;
    try {
        const texts = greetingTexts(gen);
        const found = gen.historyId && await updateHistory(gen.historyId, {
            greeting: gen.greeting?.text || '',
            greetings: texts.length > 1 ? texts : '',
        });
        if (!found && gen.greeting?.text) {
            gen.historyId = await addHistory(historyEntryFromCurrent(defaultHistoryName()));
        }
        updateHistoryUI();
    } catch (error) {
        logError('syncGreetingToHistory', error);
        showToast('error', `기록 자동 저장 실패: ${error.message}`);
    }
}

async function onGreetingGenerate() {
    if (warnIfBusy()) return;
    const gen = state.currentGeneration;
    if (!gen?.fullText) return;

    const settings = getSettings();
    const options = {
        language: $('#pf-greeting-lang').val() || gen.language,
        length: settings.greetingLength,
        customLength: String(settings.greetingLengthCustom || ''),
        pov: settings.greetingPov,
        concept: String($('#pf-greeting-concept').val() || ''),
    };
    if (options.length === 'custom' && !options.customLength.trim()) {
        showToast('warning', '원하는 길이를 적어 주십시오. (예: 3문단, 800자 안팎)');
        $('#pf-greeting-length-custom').trigger('focus');
        return;
    }

    $('#pf-greeting-panel').hide();
    $('#pf-greeting-card').hide();
    $('#pf-greeting-loading').css('display', 'flex');
    const ticker = startLoadingText('#pf-greeting-loading-text', 'greeting');
    startProgress('#pf-greeting-progress');

    try {
        const greeting = await generateGreeting(options);
        if (state.currentGeneration !== gen) return;
        renderGreeting();
        if (!greeting.truncated) playGlint('#pf-greeting-card');
        showToast(greeting.truncated ? 'warning' : 'success', greeting.truncated
            ? '그리팅이 출력 한도에 걸려 끝까지 작성되지 않았습니다. 최대 출력 토큰을 늘려 다시 시도하십시오.'
            : pickRandom(DONE_TEXTS.greeting));
        playChime('done');
        syncGreetingToHistory();
    } catch (error) {
        if (state.currentGeneration === gen) renderGreeting();
        if (isCancelError(error)) return;
        logError('greeting', error);
        playChime('error');
        showToast('error', `그리팅 생성 실패: ${error.message}`);
    } finally {
        stopLoadingText(ticker);
        stopProgress('#pf-greeting-progress');
    }
}

async function onGreetingModify() {
    if (warnIfBusy()) return;
    const gen = state.currentGeneration;
    const instruction = String($('#pf-greeting-modify-instructions').val() || '');
    if (!instruction.trim()) {
        showToast('warning', '수정 지시사항을 입력해 주십시오.');
        return;
    }

    $('#pf-greeting-modify-panel').hide();
    $('#pf-greeting-card').hide();
    $('#pf-greeting-modify').hide();
    $('#pf-greeting-loading').css('display', 'flex');
    const ticker = startLoadingText('#pf-greeting-loading-text', 'greetingModify');
    startProgress('#pf-greeting-progress');

    try {
        const greeting = await modifyGreeting(instruction);
        if (state.currentGeneration !== gen) return;
        $('#pf-greeting-modify-instructions').val('');
        renderGreeting();
        if (!greeting.truncated) playGlint('#pf-greeting-card');
        showToast(greeting.truncated ? 'warning' : 'success', greeting.truncated
            ? '수정한 그리팅이 출력 한도에 걸려 끝까지 작성되지 않았습니다. 최대 출력 토큰을 늘려 다시 시도하십시오.'
            : '그리팅이 수정되었습니다!');
        playChime('done');
        syncGreetingToHistory();
    } catch (error) {
        if (state.currentGeneration === gen) renderGreeting();
        if (isCancelError(error)) return;
        logError('greetingModify', error);
        playChime('error');
        showToast('error', `그리팅 수정 실패: ${error.message}`);
    } finally {
        stopLoadingText(ticker);
        stopProgress('#pf-greeting-progress');
    }
}

function onGreetingStop() {
    cancelOperation();
    stopLoadingText();
    stopProgress('#pf-greeting-progress');
    renderGreeting();
}

function onGreetingEditToggle() {
    const $panel = $('#pf-greeting-edit-panel');
    if ($panel.is(':visible')) {
        $panel.hide();
        $('#pf-greeting-body').show();
        return;
    }
    $('#pf-greeting-edit-text').val(state.currentGeneration?.greeting?.text || '');
    $('#pf-greeting-body').hide();
    $panel.show();
    fitToContent($('#pf-greeting-edit-text')[0]);
}

function onGreetingEditSave() {
    const text = String($('#pf-greeting-edit-text').val() || '');
    if (!text.trim()) {
        showToast('warning', '내용이 비어 있습니다. 그리팅을 지우려면 휴지통 버튼을 눌러 주십시오.');
        return;
    }
    setGreetingText(text);
    renderGreeting();
    syncGreetingToHistory();
}

async function onGreetingCopy() {
    const text = state.currentGeneration?.greeting?.text;
    if (!text) return;
    const success = await copyToClipboard(text);
    showToast(success ? 'success' : 'error', success ? '그리팅을 복사했습니다.' : '복사 실패');
}

async function onGreetingDelete() {
    if (!state.currentGeneration?.greeting?.text) return;
    const several = greetingPosition().total > 1;
    if (!(await askConfirm(several ? '지금 보고 있는 그리팅을 지우시겠습니까?' : '그리팅을 지우시겠습니까?'))) return;
    setGreetingText('');
    renderGreeting();
    syncGreetingToHistory();
}

async function onCreateCardClick() {
    const gen = state.currentGeneration;
    if (!gen?.fullText) {
        showToast('warning', '저장할 내용이 없습니다.');
        return;
    }

    const suggested = gen.charName && gen.charName !== '새 캐릭터' ? gen.charName : '';
    const name = await askText('새 캐릭터 카드의 이름을 입력하십시오:', suggested);
    if (!name || !name.trim()) return;

    const description = withProfileHeader(gen.fullText, name.trim(), { tidy: !keepsOwnTitle(gen) });
    const firstMessage = gen.greeting?.text || '';
    const context = getContext();

    try {
        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({
                ch_name: name.trim(),
                description,
                first_mes: firstMessage,
                personality: '',
                scenario: '',
                mes_example: '',
                creator_notes: '캐릭터 대장간으로 만든 캐릭터입니다.',
                system_prompt: '',
                post_history_instructions: '',
                creator: '',
                character_version: '',
                tags: [],
                talkativeness: '0.5',
                world: '',
                depth_prompt_prompt: '',
                depth_prompt_depth: '4',
                depth_prompt_role: 'system',
                fav: 'false',
                alternate_greetings: [],
                extensions: '{}',
            }),
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).trim();
            throw new Error(detail || `서버 응답 ${response.status}`);
        }

        try {
            await context.getCharacters?.();
            populateCharacterDropdown();
        } catch (error) {
            logError('refreshCharacters', error);
        }

        showToast('success', `새 캐릭터 "${name.trim()}" 카드가 만들어졌습니다${firstMessage ? ' (그리팅 포함)' : ' (그리팅은 비어 있음)'}. 캐릭터 목록에서 확인하십시오.`);
    } catch (error) {
        logError('createCharacter', error);
        const copied = await copyToClipboard(description);
        showToast(copied ? 'warning' : 'error', copied
            ? `캐릭터 카드를 만들지 못했습니다 (${error.message}). 대신 프로필을 클립보드에 복사했습니다.`
            : `캐릭터 카드를 만들지 못했습니다: ${error.message}`);
    }
}

function withProfileHeader(text, name = '', { tidy = true } = {}) {
    if (!text) return text;
    if (tidy) text = tidyTitleLines(text);
    if (/^#\s/.test(text.trim())) return text;
    const title = String(name || guessProfileName(text) || '').trim();
    return title ? `# ${title}\n\n${text}` : text;
}

function onCopyClick() {
    const text = state.currentGeneration?.fullText;
    if (!text) {
        showToast('warning', '복사할 내용이 없습니다.');
        return;
    }

    const greeting = state.currentGeneration?.mode === 'bot' ? state.currentGeneration.greeting?.text : '';
    copyToClipboard(profileWithGreeting(withProfileHeader(text, '', { tidy: !keepsOwnTitle(state.currentGeneration) }), greeting)).then(success => {
        if (success) {
            showToast('success', greeting ? '프로필과 그리팅을 복사했습니다.' : '클립보드에 복사되었습니다.');
        } else {
            showToast('error', '복사에 실패했습니다.');
        }
    });
}

async function onApplyPersonaClick() {
    const rawText = state.currentGeneration?.fullText;
    if (!rawText) {
        showToast('warning', '적용할 내용이 없습니다.');
        return;
    }
    const charName = state.currentGeneration?.charName || '';
    const defaultName = guessProfileName(rawText) || `${charName} 페르소나`;
    const personaName = await askText('새 페르소나의 이름을 입력하십시오:', defaultName);
    if (!personaName || !personaName.trim()) return;
    const text = withProfileHeader(rawText, personaName.trim(), { tidy: !keepsOwnTitle(state.currentGeneration) });

    try {
        const powerUserModule = await import("../../../../power-user.js");
        const { power_user } = powerUserModule;
        const persona_description_positions = powerUserModule.persona_description_positions;
        const scriptModule = await import("../../../../../script.js");

        if (!power_user) {
            throw new Error('power_user를 찾을 수 없습니다.');
        }

        const safeName = personaName.trim().replace(/[^a-zA-Z0-9]/g, '') || 'Persona';
        const avatarId = `${Date.now()}-${safeName}.png`;

        // 1) 페르소나 등록 — 실리태번 내장 함수 우선 (현재 버전의 데이터 구조 + 생성 이벤트)
        const personasModule = await import("../../../../personas.js").catch(() => null);
        if (typeof personasModule?.initPersona === 'function') {
            await personasModule.initPersona(avatarId, personaName.trim(), text, '');
        } else {
            power_user.personas = power_user.personas || {};
            power_user.persona_descriptions = power_user.persona_descriptions || {};

            power_user.personas[avatarId] = personaName.trim();
            power_user.persona_descriptions[avatarId] = {
                description: text,
                position: persona_description_positions?.IN_PROMPT ?? 0,
                depth: 2,
                role: 0,
                lorebook: '',
                connections: [],
                title: '',
            };
        }

        try {
            const defaultAvatar = scriptModule.default_user_avatar || '/img/ai4.png';
            const fetchResult = await fetch(defaultAvatar);
            const blob = await fetchResult.blob();
            const file = new File([blob], 'avatar.png', { type: 'image/png' });
            const formData = new FormData();
            formData.append('avatar', file);
            formData.append('overwrite_name', avatarId);

            const headers = typeof scriptModule.getRequestHeaders === 'function'
                ? scriptModule.getRequestHeaders({ omitContentType: true })
                : {};

            await fetch('/api/avatars/upload', {
                method: 'POST',
                headers,
                body: formData,
            });
        } catch (uploadError) {
            log('Avatar upload failed (persona created without avatar): ' + uploadError.message);
        }

        saveSettingsDebounced();

        try {
            if (typeof personasModule?.getUserAvatars === 'function') {
                await personasModule.getUserAvatars(true, avatarId);
            }
        } catch (e) {
            log('Avatar list refresh failed: ' + e.message);
        }

        showToast('success', `새 페르소나 "${personaName.trim()}" 가 생성되었습니다! 페르소나 관리에서 확인하십시오.`);

    } catch (error) {
        logError('createPersona', error);
        const copied = await copyToClipboard(text);
        if (copied) {
            showToast('warning', '페르소나 생성에 실패했습니다. 대신 클립보드에 복사되었습니다.');
        } else {
            showToast('error', '페르소나 생성에 실패했습니다.');
        }
    }
}

async function onSaveHistoryClick() {
    if (!state.currentGeneration) {
        showToast('warning', '저장할 내용이 없습니다.');
        return;
    }

    const name = await askText('기록 이름을 입력하십시오:', defaultHistoryName());
    if (!name) return;

    try {
        state.currentGeneration.historyId = await addHistory(historyEntryFromCurrent(name));
        showToast('success', '기록에 저장되었습니다.');
        updateHistoryUI();
    } catch (error) {
        logError('saveHistory', error);
        showToast('error', `기록 저장 실패: ${error.message}`);
    }
}

let historyRenderRevision = 0;

let historySelectMode = false;
const HISTORY_PAGE_SIZE = 20;
let historyPage = 1;
const historySelected = new Set();
let historyVisibleIds = [];

function setHistorySelectMode(enabled) {
    historySelectMode = enabled;
    historySelected.clear();
    updateHistoryUI();
}

function updateHistorySelectionControls() {
    $('#pf-history-controls').toggleClass('pf-selecting', historySelectMode);
    if (!historySelectMode) return;
    const count = historySelected.size;
    $('#pf-history-count').text(count ? `${count}개 선택됨` : '삭제할 기록을 고르십시오');
    $('#pf-history-delete-selected').prop('disabled', !count).find('span').text(count ? `${count}개 삭제` : '선택 삭제');
    const allSelected = historyVisibleIds.length > 0 && historyVisibleIds.every(id => historySelected.has(id));
    $('#pf-history-select-all').text(allSelected ? '선택 해제' : '전체 선택');
}

function onHistorySelectAll() {
    const allSelected = historyVisibleIds.length > 0 && historyVisibleIds.every(id => historySelected.has(id));
    for (const id of historyVisibleIds) {
        if (allSelected) historySelected.delete(id);
        else historySelected.add(id);
    }
    $('.pf-history-check').each(function () {
        const checked = historySelected.has(String($(this).attr('data-id')));
        $(this).prop('checked', checked).closest('.pf-history-item').toggleClass('pf-selected', checked);
    });
    updateHistorySelectionControls();
}

async function onHistoryDeleteSelected() {
    const ids = [...historySelected];
    if (!ids.length) return;
    const ok = await confirmDialog('선택한 기록 삭제', `<p>선택한 기록 ${ids.length}개를 삭제하시겠습니까? 되돌릴 수 없습니다.</p>`, '삭제');
    if (!ok) return;
    try {
        await deleteHistoryItems(ids);
        historySelectMode = false;
        historySelected.clear();
        updateHistoryUI();
    } catch (error) {
        logError('deleteHistoryItems', error);
        showToast('error', `삭제 실패: ${error.message}`);
    }
}

const RESULT_KIND_LABELS = { original: '원본', translation: '번역', modified: '수정', personal: '개인' };

function defaultHistoryName() {
    const gen = state.currentGeneration;
    if (gen?.mode === 'bot') return gen.charName || '새 캐릭터';
    return guessProfileName(gen?.fullText) || gen?.charName || 'Unknown';
}

// 기록 목록에 보일 이름 — 예전에 자동으로 붙던 " 페르소나"는 배지로 대신하므로 뗌
function historyDisplayName(item) {
    const name = String(item.name || '');
    if (item.mode !== 'bot' && item.charName && name === `${item.charName} 페르소나`) return item.charName;
    return name;
}

function historyEntryFromCurrent(name) {
    const gen = state.currentGeneration;
    return {
        name,
        charName: gen.charName,
        charAvatar: gen.charAvatar,
        manualCharacter: gen.manualCharacter,
        fullText: gen.fullText,
        language: gen.language,
        templateId: gen.templateId,
        noTarget: !!gen.noTarget,
        wiNames: gen.wiNames?.length ? gen.wiNames : undefined,
        kind: gen.resultKind || 'original',
        mode: gen.mode === 'bot' ? 'bot' : 'persona',
        refName: gen.refName || '',
        direction: gen.direction || '',
        personaId: gen.personaId || '',
        greeting: gen.greeting?.text || '',
        greetings: greetingTexts(gen).length > 1 ? greetingTexts(gen) : undefined,
        worldOnly: !!gen.worldOnly,
        supportChat: supportChatForSave(gen.supportChat) || undefined,
        supportGender: supportChatForSave(gen.supportChat) ? gen.supportGender : undefined,
        conceptText: gen.conceptText || '',
    };
}

function autoSaveToHistory() {
    const gen = state.currentGeneration;
    if (!getSettings().autoSaveHistory || !gen?.fullText) return;
    addHistory(historyEntryFromCurrent(defaultHistoryName()))
        .then(id => {
            gen.historyId = id; // 이후 만든 그리팅을 이 기록에 붙이기 위해
            updateHistoryUI();
        })
        .catch(error => {
            logError('autoSaveHistory', error);
            showToast('error', `기록 자동 저장 실패: ${error.message}`);
        });
}

function historyBadgesHtml(item) {
    const badges = [];
    badges.push(item.mode === 'bot'
        ? '<span class="pf-badge pf-badge-bot">봇</span>'
        : '<span class="pf-badge pf-badge-persona">페르소나</span>');
    const kindLabel = RESULT_KIND_LABELS[item.kind];
    if (kindLabel) badges.push(`<span class="pf-badge pf-badge-${escapeHtml(item.kind)}">${kindLabel}</span>`);
    return badges.join('');
}

async function updateHistoryUI({ refresh = false } = {}) {
    const revision = ++historyRenderRevision;
    renderForgeRank();
    const $list = $('#pf-history-list');
    const $empty = $('#pf-history-empty');
    const $controls = $('#pf-history-controls');

    let history;
    try {
        history = await listHistory({ refresh });
    } catch (error) {
        logError('listHistory', error);
        history = [];
    }
    if (revision !== historyRenderRevision) return;

    // 보관 개수를 넘어 오래된 기록이 지워졌으면 알림 (기록을 넣은 뒤에는 늘 이 함수로 목록을 다시 그림)
    const evicted = takeEvictedCount();
    if (evicted) {
        showToast('warning', `기록이 ${HISTORY_LIMIT}개를 넘어 가장 오래된 기록 ${evicted}개가 지워졌습니다. (즐겨찾기한 기록은 지워지지 않습니다)`);
    }
    // 거의 찼으면 기록 탭에 미리 안내
    $('#pf-history-limit-note')
        .text(`기록이 ${history.length}개입니다. ${HISTORY_LIMIT}개를 넘으면 즐겨찾기하지 않은 오래된 기록부터 자동으로 지워집니다. 남길 기록은 즐겨찾기하거나, 오른쪽 위 ⋮ 메뉴의 '기록 내보내기'로 백업해 두십시오.`)
        .toggle(history.length >= HISTORY_WARN_AT);

    if (!history.length) {
        historySelectMode = false;
        historySelected.clear();
        historyVisibleIds = [];
        historyPage = 1;
        $list.hide();
        $('#pf-history-pager').hide();
        $controls.hide();
        $empty.show();
        $empty.html(`
            <div class="pf-empty-icon"><i class="fa-solid fa-clock-rotate-left"></i></div>
            <p>저장된 기록이 없습니다.</p>
            <p class="pf-text-muted">⋮ 메뉴의 "기록 가져오기"로 예전에 내보낸 기록을 불러올 수 있습니다.</p>
        `);
        return;
    }

    $controls.show();
    const existingIds = new Set(history.map(item => item.id));
    for (const id of [...historySelected]) if (!existingIds.has(id)) historySelected.delete(id);

    const searchTerm = ($('#pf-history-search').val() || '').toLowerCase().trim();
    const filterLang = $('#pf-history-filter-lang').val() || '';
    const filterTemplate = $('#pf-history-filter-template').val() || '';
    const filterMode = $('#pf-history-filter-mode').val() || '';

    const filtered = history.filter(item => {
        if (searchTerm) {
            const target = `${item.name || ''} ${item.charName || ''}`.toLowerCase();
            if (!target.includes(searchTerm)) return false;
        }
        if (filterLang && item.language !== filterLang) return false;
        if (filterTemplate && item.templateId !== filterTemplate) return false;
        if (filterMode === 'favorite') {
            if (!item.favorite) return false;
        } else if (filterMode && (item.mode === 'bot' ? 'bot' : 'persona') !== filterMode) return false;
        return true;
    });

    historyVisibleIds = filtered.map(item => item.id);
    if (!historySelectMode) {
        $('#pf-history-count').text(filtered.length === history.length ? `기록 ${history.length}개` : `기록 ${filtered.length}개 / 전체 ${history.length}개`);
    }
    updateHistorySelectionControls();

    if (!filtered.length) {
        $list.hide();
        $('#pf-history-pager').hide();
        $empty.show();
        $empty.html(filterMode === 'favorite' && !searchTerm && !filterLang && !filterTemplate ? `
            <div class="pf-empty-icon"><i class="fa-regular fa-star"></i></div>
            <p>즐겨찾기한 기록이 없습니다.</p>
            <p class="pf-text-muted">기록 옆의 ☆를 누르면 즐겨찾기에 들어가고, 오래된 기록이 정리될 때도 지워지지 않습니다.</p>
        ` : `
            <div class="pf-empty-icon"><i class="fa-solid fa-magnifying-glass"></i></div>
            <p>검색 결과가 없습니다.</p>
        `);
        return;
    }

    $empty.hide();
    $list.show();

    const pages = Math.ceil(filtered.length / HISTORY_PAGE_SIZE);
    historyPage = Math.min(Math.max(1, historyPage), pages);
    const pageItems = filtered.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE);
    $('#pf-history-pager').toggle(pages > 1);
    $('#pf-history-page').text(`${historyPage} / ${pages}`);
    $('#pf-history-prev').prop('disabled', historyPage <= 1);
    $('#pf-history-next').prop('disabled', historyPage >= pages);

    $list.html(pageItems.map(item => {
        const date = new Date(item.timestamp).toLocaleDateString('ko-KR', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
        const langLabel = LANGUAGES[item.language]?.label || item.language;
        const id = escapeHtml(item.id);
        const isBot = item.mode === 'bot';
        const checked = historySelected.has(item.id);
        const lead = historySelectMode
            ? `<label class="pf-history-check-wrap"><input type="checkbox" class="pf-history-check" data-id="${id}" ${checked ? 'checked' : ''}></label>`
            : `<span class="pf-list-icon${isBot ? ' pf-list-icon-bot' : ''}"><i class="fa-solid ${isBot ? 'fa-robot' : 'fa-user'}"></i></span>`;
        return `
        <div class="pf-history-item${historySelectMode ? ' pf-selectable' : ' pf-loadable'}${checked ? ' pf-selected' : ''}" data-id="${id}"${historySelectMode ? '' : ' tabindex="0" title="눌러서 불러오기"'}>
            ${lead}
            <div class="pf-history-info">
                <div class="pf-history-name">${historyBadgesHtml(item)}<span>${escapeHtml(historyDisplayName(item))}</span></div>
                <div class="pf-history-meta">${[historyMetaHtml(item), escapeHtml(langLabel), date].filter(Boolean).join(' · ')}</div>
            </div>
            <div class="pf-history-actions">
                <button class="pf-history-fav pf-btn pf-small-btn${item.favorite ? ' pf-on' : ''}" data-id="${id}" title="${item.favorite ? '즐겨찾기 해제' : '즐겨찾기'}"><i class="fa-${item.favorite ? 'solid' : 'regular'} fa-star"></i></button>
                <button class="pf-history-duplicate pf-btn pf-small-btn" data-id="${id}" title="복제 — 원본은 그대로 두고 사본을 만듭니다 (모루와의 대화까지)"><i class="fa-solid fa-code-branch"></i></button>
                <button class="pf-history-copy pf-btn pf-small-btn" data-id="${id}" title="복사"><i class="fa-regular fa-copy"></i></button>
                <button class="pf-history-delete pf-btn pf-small-btn pf-danger-btn" data-id="${id}" title="삭제"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        </div>`;
    }).join(''));
}

// 캐릭터 없이 월드인포만 참고했을 때 — 참고한 북 이름 (예전 기록은 이름이 없음)
function worldInfoNote(names) {
    return names?.length ? `월드인포: ${names.join(', ')}` : '월드인포만 참고';
}

function historyMetaHtml(item) {
    if (item.mode === 'bot' && item.templateId !== 'manual') {
        return [
            item.refName ? `참고: ${escapeHtml(item.refName)}` : (item.wiNames?.length ? escapeHtml(worldInfoNote(item.wiNames)) : ''),
            item.greeting ? '<i class="fa-regular fa-comment-dots" title="그리팅 포함"></i> 그리팅' : '',
        ].filter(Boolean).join(' · ');
    }
    if (item.templateId === 'manual') return '직접 추가';
    return item.noTarget ? escapeHtml(worldInfoNote(item.wiNames)) : `참고: ${escapeHtml(item.charName)}`;
}

function onHistoryFilterChange() {
    historyPage = 1;
    updateHistoryUI();
}

function changeHistoryPage(step) {
    historyPage += step;
    updateHistoryUI().then(() => {
        const list = document.getElementById('pf-history-list');
        list?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
}

// 직접 작성한 프로필을 기록에 추가 — 불러와서 번역·수정·섹션 재생성을 쓸 수 있게
async function onHistoryAddSave() {
    const text = String($('#pf-history-add-text').val() || '').trim();
    if (!text) {
        showToast('warning', '저장할 프로필을 붙여 넣어 주십시오.');
        return;
    }
    const mode = $('#pf-history-add-mode').val() === 'bot' ? 'bot' : 'persona';
    const name = String($('#pf-history-add-name').val() || '').trim() || guessProfileName(text) || '직접 추가한 프로필';
    try {
        await addHistory({
            name, charName: name, fullText: text,
            language: String($('#pf-history-add-lang').val() || 'en'),
            templateId: 'manual', kind: 'personal', mode,
            // 페르소나는 어떤 캐릭터용인지 모르므로 재생성·수정 때 지금 고른 캐릭터를 끌어오지 않게
            noTarget: mode === 'persona',
        });
        $('#pf-history-add-text, #pf-history-add-name').val('');
        $('#pf-history-add-panel').hide();
        historyPage = 1;
        updateHistoryUI();
    } catch (error) {
        logError('historyAdd', error);
        showToast('error', `기록에 추가하지 못했습니다: ${error.message}`);
    }
}

async function onHistoryFavorite(e) {
    e.stopPropagation();
    const id = String($(this).attr('data-id'));
    const item = await findHistoryItem(id);
    if (!item) return;
    // 파일 저장을 기다리지 않고 별부터 바로 바꿔 보여줌
    const on = !item.favorite;
    $(this).toggleClass('pf-on', on).attr('title', on ? '즐겨찾기 해제' : '즐겨찾기')
        .find('i').attr('class', `fa-${on ? 'solid' : 'regular'} fa-star`);
    try {
        await updateHistory(id, { favorite: on ? true : null });
        await updateHistoryUI();
    } catch (error) {
        logError('historyFavorite', error);
        showToast('error', `즐겨찾기를 바꾸지 못했습니다: ${error.message}`);
    }
}

async function findHistoryItem(id) {
    return (await listHistory()).find(h => h.id === id);
}

async function onHistoryLoad() {
    // 생성 중에 다른 결과를 띄우면 "생성 화면 보기"를 눌러도 진행 화면 대신 그 결과가 보이므로 막음
    if (state.isGenerating) {
        showToast('info', '생성이 끝난 뒤에 불러올 수 있습니다. (복사는 지금도 가능)');
        return;
    }
    const id = String($(this).attr('data-id'));
    const item = await findHistoryItem(id);
    if (!item) return;

    const itemMode = item.mode === 'bot' ? 'bot' : 'persona';
    if (!(await switchForgeMode(itemMode))) return;

    const isCustom = item.templateId === 'custom'
        || ([MIRROR_TEMPLATE.id, 'manual'].includes(item.templateId) && countMainSections(item.fullText) === 0);
    state.currentGeneration = {
        mode: itemMode,
        noTarget: !!item.noTarget,
        wiNames: item.wiNames || [],
        refName: item.refName || '',
        direction: item.direction || '',
        personaId: item.personaId || '',
        conceptText: item.conceptText || '',
        ...greetingsFromHistory(item),
        worldOnly: !!item.worldOnly,
        supportChat: await loadSupportChat(item), // 대화 파일(또는 예전 기록 안의 대화)에서 — 기록 목록과는 따로인 사본
        supportGender: item.supportGender === 'male' || item.supportGender === 'female' ? item.supportGender : '',
        historyId: item.id,
        sections: isCustom ? { _custom: { header: '', content: item.fullText } } : parseResponse(item.fullText),
        fullText: item.fullText,
        charName: item.charName,
        charAvatar: item.charAvatar || '',
        manualCharacter: item.manualCharacter || null,
        templateId: item.templateId,
        language: item.language,
        resultKind: item.kind || 'original',
        timestamp: item.timestamp,
        isCustomSheet: isCustom,
    };

    const charIndex = findCharacterIndex(item.charAvatar);
    if (charIndex >= 0 && charIndex !== state.selectedCharIndex) {
        onCharacterSelect(charIndex);
    }

    renderGenerationResult(state.currentGeneration);
    switchTab('generate');
}

// 기록의 그리팅 (여러 버전이면 모두, 저장해 둔 버전을 보고 있는 것으로)
function greetingsFromHistory(item) {
    const texts = item.greetings?.length ? item.greetings : (item.greeting ? [item.greeting] : []);
    const greetings = texts.map(text => ({ text, truncated: false }));
    return { greetings, greeting: greetings.find(g => g.text === item.greeting) || greetings.at(-1) || null };
}

// 전체 복사 — 그리팅이 있으면 프로필 아래 "# Greeting"으로 붙임
function profileWithGreeting(text, greeting) {
    return greeting ? `${text}\n\n# Greeting\n\n${greeting}` : text;
}

async function onHistoryCopy() {
    const id = String($(this).attr('data-id'));
    const item = await findHistoryItem(id);
    if (!item) return;

    const success = await copyToClipboard(profileWithGreeting(withProfileHeader(item.fullText, '', { tidy: !keepsOwnTitle(item) }), item.greeting));
    showToast(success ? 'success' : 'error', success ? (item.greeting ? '프로필과 그리팅을 복사했습니다.' : '클립보드에 복사되었습니다.') : '복사에 실패했습니다.');
}

async function onHistoryDuplicate() {
    const id = String($(this).attr('data-id'));
    try {
        const copyId = await duplicateHistory(id);
        if (!copyId) return;
        historyPage = 1;
        await updateHistoryUI();
        showToast('success', '맨 위에 사본을 만들었습니다. 눌러서 불러오면 사본에서 이어 작업합니다.');
    } catch (error) {
        logError('duplicateHistory', error);
        showToast('error', `복제 실패: ${error.message}`);
    }
}

async function onHistoryDelete() {
    const id = String($(this).attr('data-id'));
    if (!(await askConfirm('이 항목을 삭제하시겠습니까?'))) return;
    try {
        await deleteHistory(id);
        updateHistoryUI();
    } catch (error) {
        logError('deleteHistory', error);
        showToast('error', `삭제 실패: ${error.message}`);
    }
}

async function onHistoryClear() {
    if (!(await askConfirm('전체 기록을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.'))) return;
    try {
        await clearHistory();
        updateHistoryUI();
    } catch (error) {
        logError('clearHistory', error);
        showToast('error', `삭제 실패: ${error.message}`);
    }
}

async function onHistoryExport() {
    const history = await exportHistoryItems(); // 모루 남매와의 대화도 합쳐서
    if (!history.length) {
        showToast('warning', '내보낼 기록이 없습니다.');
        return;
    }

    const json = JSON.stringify(history, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `persona-forge-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('success', `${history.length}개 항목을 내보냈습니다.`);
}

function onHistoryImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const imported = JSON.parse(await file.text());
            if (!Array.isArray(imported)) throw new Error('Invalid format');
            const added = await importHistory(imported);
            updateHistoryUI();
            showToast('success', `${added}개의 새 항목을 가져왔습니다.`);
        } catch (err) {
            logError('historyImport', err);
            showToast('error', '가져오기 실패: 유효하지 않은 파일이거나 저장에 실패했습니다.');
        }
    };
    input.click();
}

function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
}

// 완료 알림음 — 파일 없이 브라우저에서 짧은 소리를 만듦 (성공: 높은 두 음 / 실패: 낮은 두 음)
let audioContext = null;

function primeAudio() {
    if (getSettings()?.completionSound === false) return;
    try {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return;
        audioContext ||= new Context();
        if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
    } catch {
        audioContext = null;
    }
}

function playChime(kind = 'done') {
    if (getSettings()?.completionSound === false || !audioContext) return;
    try {
        if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
        const notes = kind === 'done' ? [[1318.5, 0], [1760, 0.1]] : [[392, 0], [311, 0.14]];
        const start = audioContext.currentTime + 0.02;
        for (const [frequency, delay] of notes) {
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            oscillator.type = kind === 'done' ? 'sine' : 'triangle';
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, start + delay);
            gain.gain.exponentialRampToValueAtTime(0.16, start + delay + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.5);
            oscillator.connect(gain).connect(audioContext.destination);
            oscillator.start(start + delay);
            oscillator.stop(start + delay + 0.55);
        }
    } catch { /* 소리를 낼 수 없는 환경 */ }
}

function playGlint(target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.remove('pf-glint');
    void el.offsetWidth;
    el.classList.add('pf-glint');
    clearTimeout(el.pfGlintTimer);
    el.pfGlintTimer = setTimeout(() => el.classList.remove('pf-glint'), 1500);
}

function onTitleHammerClick() {
    hammerTaps += 1;
    this.classList.remove('pf-hammer-swing');
    void this.offsetWidth;
    this.classList.add('pf-hammer-swing');
    const word = hammerTaps % 10 === 0 ? '손목 조심하십시오!' : '깡!';
    const $pop = $('<span class="pf-hammer-pop" aria-hidden="true"></span>').text(word);
    $(this).closest('.pf-title').append($pop);
    setTimeout(() => $pop.remove(), 900);
}

function forgeRankOf(count) {
    let level = 0;
    FORGE_RANKS.forEach((rank, index) => { if (count >= rank.min) level = index; });
    return { level, rank: FORGE_RANKS[level], next: FORGE_RANKS[level + 1] || null };
}

function renderForgeRank() {
    const count = getSettings()?.forgedCount || 0;
    const { level, rank, next } = forgeRankOf(count);
    $('#pf-forge-rank').attr('data-level', level);
    $('#pf-forge-rank-name').text(rank.name);
    $('#pf-forge-rank-count').text(count
        ? `벼려낸 인물 ${count}명${next ? ` · 다음 칭호까지 ${next.min - count}명` : ''}`
        : '아직 벼려낸 인물이 없습니다');
}

async function seedForgedCount() {
    if (getSettings().forgedCount != null) return;
    let count = 0;
    try {
        count = (await listHistory()).filter(item => !item.kind || item.kind === 'original').length;
    } catch (error) {
        logError('seedForgedCount', error);
    }
    const settings = getSettings();
    if (settings.forgedCount != null) return;
    settings.forgedCount = count;
    saveSettings();
    renderForgeRank();
}

function countForged() {
    const settings = getSettings();
    const before = forgeRankOf(settings.forgedCount || 0).level;
    settings.forgedCount = (settings.forgedCount || 0) + 1;
    saveSettings();
    renderForgeRank();
    const after = forgeRankOf(settings.forgedCount);
    if (after.level > before) setTimeout(() => showToast('success', `칭호가 올랐습니다: ${after.rank.name}!`), 800);
}

function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showToast(type, message) {
    if (typeof toastr !== 'undefined' && toastr[type]) {
        const opts = type === 'error' ? { timeOut: 7000 } : {};
        toastr[type](message, '캐릭터 대장간', opts);
    } else {
        console.log(`[${extensionName}] ${type}: ${message}`);
    }
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e2) {
            return false;
        }
    }
}

let currentPromptSlot = 'role';
// 프롬프트 탭에서 보고 있는 묶음 (페르소나 / 봇 / 서포터) — 모드를 바꾸면 그 모드로
let promptScope = null;

function updatePromptUI() {
    if (!getSettings()) return;
    if (promptScope !== 'supporter') promptScope = isBotMode() ? 'bot' : 'persona';
    $('.pf-prompt-scope-btn').each(function () {
        $(this).attr('aria-pressed', String($(this).attr('data-scope') === promptScope));
    });
    populatePromptSlots();
    loadPromptSlot(currentPromptSlot);
    populatePromptPresets();
    updateLegacyUI();
    renderStructure();
}

// 목록 순서 — 그 탭 전용([페르소나]·[봇]·[서포터]) → [세계관만] → [공통]
function promptSlotGroup(slot) {
    const label = PROMPT_SLOTS[slot].label;
    if (label.startsWith('[공통]')) return 2;
    if (label.startsWith('[세계관만]')) return 1;
    return 0;
}

function visiblePromptSlots() {
    const scope = promptScope || (isBotMode() ? 'bot' : 'persona');
    return Object.keys(PROMPT_SLOTS)
        .filter(slot => (PROMPT_SLOTS[slot].modes || ['persona', 'bot']).includes(scope))
        .map((slot, index) => ({ slot, index, group: promptSlotGroup(slot) }))
        .sort((a, b) => a.group - b.group || a.index - b.index)
        .map(item => item.slot);
}

async function onPromptScopeChange() {
    const scope = String($(this).attr('data-scope'));
    if (scope === promptScope) return;
    if (isPromptEditorDirty() && !(await askConfirm('적용하지 않은 변경이 있습니다. 버리고 다른 묶음으로 이동하시겠습니까?'))) return;
    promptScope = scope;
    $('.pf-prompt-scope-btn').each(function () {
        $(this).attr('aria-pressed', String($(this).attr('data-scope') === promptScope));
    });
    populatePromptSlots();
    loadPromptSlot(currentPromptSlot);
}

function populatePromptSlots() {
    const $select = $('#pf-prompt-slot');
    const slots = visiblePromptSlots();
    if (!slots.includes(currentPromptSlot)) currentPromptSlot = slots[0];
    $select.html(slots.map(slot =>
        `<option value="${slot}">${escapeHtml(PROMPT_SLOTS[slot].label)}${isPromptCustomized(slot) ? ' ● 수정됨' : ''}</option>`).join(''));
    $select.val(currentPromptSlot);
}

function loadPromptSlot(slot) {
    const slots = visiblePromptSlots();
    currentPromptSlot = slots.includes(slot) ? slot : slots[0];
    $('#pf-prompt-slot').val(currentPromptSlot);
    $('#pf-prompt-slot-hint').text(PROMPT_SLOTS[currentPromptSlot].hint || '');
    $('#pf-prompt-editor').val(getPrompt(currentPromptSlot));
    updatePromptStatus();
}

function isPromptEditorDirty() {
    return String($('#pf-prompt-editor').val() || '').trim() !== getPrompt(currentPromptSlot).trim();
}

function updatePromptStatus() {
    let text;
    if (isPromptEditorDirty()) text = '적용하지 않은 변경 있음';
    else if (!getPrompt(currentPromptSlot)) text = '비어 있음 — 이 블록은 들어가지 않음';
    else if (isPromptCustomized(currentPromptSlot)) text = '수정본 사용 중';
    else text = '기본값 사용 중';
    $('#pf-prompt-status').text(text).toggleClass('pf-prompt-status-dirty', isPromptEditorDirty());
}

async function onPromptSlotChange() {
    const $select = $(this);
    const next = $select.val();
    if (isPromptEditorDirty() && !(await askConfirm('적용하지 않은 변경이 있습니다. 버리고 다른 프롬프트로 이동하시겠습니까?'))) {
        $select.val(currentPromptSlot);
        return;
    }
    loadPromptSlot(next);
}

function onPromptReset() {
    resetPrompt(currentPromptSlot);
    loadPromptSlot(currentPromptSlot);
    populatePromptSlots();
}

function onPromptApply() {
    const text = $('#pf-prompt-editor').val();
    const def = PROMPT_SLOTS[currentPromptSlot];
    if (def.requireText && !text.trim()) {
        showToast('warning', `"${def.label}"은(는) 비워 둘 수 없습니다. 기본값으로 되돌리려면 "기본값 복원"을 누르십시오.`);
        return;
    }
    setCustomPrompt(currentPromptSlot, text);
    populatePromptSlots();
    updatePromptStatus();
    renderStructure();
    renderSupportIdentity();
    showToast('success', isPromptCustomized(currentPromptSlot)
        ? `"${def.label}" 수정본이 적용되었습니다.`
        : `"${def.label}" 기본값과 같아 기본값을 사용합니다.`);
}

function populatePromptPresets() {
    const presets = getSettings()?.promptPresets || [];
    const $select = $('#pf-prompt-preset-select');

    $select.empty();
    $select.append('<option value="">프리셋을 선택하십시오...</option>');
    // 고정 프리셋 — 모든 프롬프트를 기본값으로 (지울 수 없음)
    $select.append('<option value="default">기본 (모든 프롬프트 기본값)</option>');
    presets.forEach((preset, idx) => {
        const count = Object.keys(preset.prompts || {}).length;
        $select.append(`<option value="${idx}">${escapeHtml(preset.name)} (${count}개 수정)</option>`);
    });
}

async function onPromptPresetSave() {
    const name = $('#pf-prompt-preset-name').val().trim();
    if (!name) {
        showToast('warning', '프리셋 이름을 입력하십시오.');
        return;
    }
    if (isPromptEditorDirty() && !(await askConfirm('편집기에 적용하지 않은 변경이 있습니다. 적용된 내용만 저장하시겠습니까?'))) return;

    const settings = getSettings();
    const prompts = structuredClone(settings.customPrompts || {});
    if (!Object.keys(prompts).length) {
        showToast('warning', '수정한 프롬프트가 없습니다. 기본값은 프리셋으로 저장할 필요가 없습니다.');
        return;
    }

    settings.promptPresets ||= [];
    const existIdx = settings.promptPresets.findIndex(p => p.name === name);
    if (existIdx >= 0) {
        if (!(await askConfirm(`프리셋 "${name}"을(를) 덮어쓰시겠습니까?`))) return;
        settings.promptPresets[existIdx] = { name, prompts };
    } else {
        settings.promptPresets.push({ name, prompts });
    }

    saveSettings();
    populatePromptPresets();
    $('#pf-prompt-preset-name').val('');
    showToast('success', `프리셋 "${name}"이(가) 저장되었습니다.`);
}

// 프리셋을 불러온 뒤 — 편집 칸·구조 안내·서포터 이름 다시 그리기
function refreshAfterPromptPreset() {
    populatePromptSlots();
    loadPromptSlot(currentPromptSlot);
    renderStructure();
    renderSupportIdentity();
}

async function onPromptPresetLoad() {
    const value = $('#pf-prompt-preset-select').val();
    const settings = getSettings();
    if (value === 'default') {
        if (!Object.keys(settings.customPrompts || {}).length) {
            showToast('info', '이미 모든 프롬프트가 기본값입니다.');
            return;
        }
        if (!(await askConfirm('모든 프롬프트를 기본값으로 되돌리시겠습니까? 지금 수정한 프롬프트는 사라집니다. (남겨 두려면 먼저 프리셋으로 저장하십시오)'))) return;
        settings.customPrompts = {};
        saveSettings();
        refreshAfterPromptPreset();
        showToast('success', '모든 프롬프트를 기본값으로 되돌렸습니다.');
        return;
    }
    const idx = parseInt(value, 10);
    const preset = settings?.promptPresets?.[idx];
    if (isNaN(idx) || !preset) {
        showToast('warning', '불러올 프리셋을 선택하십시오.');
        return;
    }
    if (Object.keys(settings.customPrompts || {}).length
        && !(await askConfirm(`프리셋 "${preset.name}"을(를) 적용하면 지금 수정한 프롬프트가 모두 바뀝니다. 계속하시겠습니까?`))) return;

    settings.customPrompts = structuredClone(preset.prompts || {});
    saveSettings();
    refreshAfterPromptPreset();
    showToast('success', `프리셋 "${preset.name}"을(를) 적용했습니다.`);
}

async function onPromptPresetDelete() {
    const value = $('#pf-prompt-preset-select').val();
    if (value === 'default') {
        showToast('info', '기본 프리셋은 지울 수 없습니다.');
        return;
    }
    const idx = parseInt(value, 10);
    const settings = getSettings();

    if (isNaN(idx) || !settings?.promptPresets?.[idx]) {
        showToast('warning', '삭제할 프리셋을 선택하십시오.');
        return;
    }

    const name = settings.promptPresets[idx].name;
    if (!(await askConfirm(`프리셋 "${name}"을(를) 삭제하시겠습니까?`))) return;
    settings.promptPresets.splice(idx, 1);
    saveSettings();
    populatePromptPresets();
}

const LEGACY_SLOT_LABELS = {
    system: '생성 시스템 프롬프트', regen: '섹션 재생성 시스템 프롬프트', translate: '번역 시스템 프롬프트',
    modify: '전체 수정 시스템 프롬프트', userNote: '{{user}} 안내', preamble: '요청 앞머리', closing: '요청 끝맺음',
};

function legacyItems() {
    const items = [];
    (getSettings()?.legacyPrompts || []).forEach((set, setIdx) => {
        for (const [key, text] of Object.entries(set.prompts || {})) {
            items.push({ setIdx, key, label: `${set.name} — ${LEGACY_SLOT_LABELS[key] || key}`, text: String(text || '') });
        }
    });
    return items;
}

function updateLegacyUI() {
    const items = legacyItems();
    $('#pf-legacy-section').toggle(items.length > 0);
    if (!items.length) return;
    const $select = $('#pf-legacy-select');
    const previous = $select.val();
    $select.html(items.map((item, idx) => `<option value="${idx}">${escapeHtml(item.label)}</option>`).join(''));
    if (previous && items[previous]) $select.val(previous);
    renderLegacyText();
}

function renderLegacyText() {
    const item = legacyItems()[Number($('#pf-legacy-select').val())];
    $('#pf-legacy-text').val(item?.text || '');
}

async function onLegacyCopy() {
    const text = $('#pf-legacy-text').val();
    if (!text) return;
    const ok = await copyToClipboard(text);
    showToast(ok ? 'success' : 'error', ok ? '복사했습니다.' : '복사 실패');
}

async function onLegacyDelete() {
    const item = legacyItems()[Number($('#pf-legacy-select').val())];
    if (!item || !(await askConfirm(`"${item.label}"을(를) 보관함에서 삭제하시겠습니까?`))) return;
    const settings = getSettings();
    const set = settings.legacyPrompts[item.setIdx];
    delete set.prompts[item.key];
    if (!Object.keys(set.prompts).length) settings.legacyPrompts.splice(item.setIdx, 1);
    saveSettings();
    updateLegacyUI();
}

function renderStructure() {
    if (!$('#pf-structure').prop('open')) return;
    const kind = $('#pf-structure-kind').val() || 'generate';
    let items;
    try {
        items = describeStructure(kind, { conceptText: $('#pf-concept-text').val() || '' });
    } catch (error) {
        $('#pf-structure-list').html(`<li class="pf-structure-item">${escapeHtml(error.message)}</li>`);
        return;
    }

    let previousWhere = '';
    $('#pf-structure-list').html(items.map((item, idx) => {
        const group = item.where !== previousWhere
            ? `<li class="pf-structure-group">${item.where === 'system' ? '시스템 메시지' : '사용자 메시지'}</li>`
            : '';
        previousWhere = item.where;
        return `${group}
        <li class="pf-structure-item${item.included ? '' : ' pf-structure-off'}">
            <div class="pf-structure-head">
                <span class="pf-structure-num">${idx + 1}</span>
                <span class="pf-structure-name">${escapeHtml(item.name)}</span>
                <span class="pf-structure-badge${item.editable ? ' pf-structure-editable' : ''}">${item.editable ? '수정 가능' : '자동'}</span>
                <span class="pf-structure-state">${item.included ? '포함' : `생략 · ${escapeHtml(item.reason)}`}</span>
            </div>
            <div class="pf-structure-desc">${escapeHtml(item.desc)}</div>
        </li>`;
    }).join(''));
}

function toggleMoreMenu() {
    const $menu = $('#pf-more-menu');
    if ($menu.is(':visible')) {
        closeMoreMenu();
        return;
    }
    const backend = getHistoryBackend();
    $('#pf-more-storage').text(backend === 'settings'
        ? '확장 설정 (이 실리태번에서는 파일 저장을 쓸 수 없음)'
        : `user/files/${HISTORY_FILE_NAME}`);
    $menu.show();
    $('#pf-more-btn').attr('aria-expanded', 'true');
}

function closeMoreMenu() {
    $('#pf-more-menu').hide();
    $('#pf-more-btn').attr('aria-expanded', 'false');
}

const RESETTABLE_LABELS = {
    forgeMode: '페르소나/봇 전환', botDirection: '봇 설계 방향', botPersona: '봇 — 참고할 내 페르소나', personaBase: '페르소나 — 바탕으로 삼을 내 페르소나',
    greetingLength: '그리팅 길이', greetingPov: '그리팅 시점', streamRequests: '스트리밍으로 받기',
    generationMode: '생성 모드', templatePreset: '캐릭터 설정 템플릿', customFields: '캐릭터 설정 — Choice 항목 선택·순서',
    language: '출력 언어', connectionProfile: 'API 프로필', maxTokens: '최대 출력 토큰',
    includeWorldInfo: '월드인포 켜기', cardFields: '참고할 카드 항목', autoSaveHistory: '기록 자동 저장',
    spoilerProtection: '스포일러 방지', density: '분량', completionSound: '완료 알림음', includeSetting: '세계관 설정 켜기', includeCharacter: '캐릭터 설정 켜기', settingFields: '세계관 항목 선택·순서',
    supporterProfile: '대화형 서포터 연결 프로필', supporterGender: '대화 상대 기본값', supporterUserName: '나를 부를 이름',
    supporterUserGender: '내 성별', supporterUserIntro: '자기소개', uiFontSize: '글자 크기', chatFontSize: '대화 글자 크기', uiFontFamily: '글꼴',
};

// 실리태번 확인 대화상자 (없으면 브라우저 기본 확인창)
// 브라우저 기본 창은 "이 페이지의 추가 대화상자 차단"을 한 번 누르면 조용히 취소되므로 실리태번 창을 우선 씀
async function confirmDialog(title, bodyHtml, okText, extraButtons = []) {
    const context = getContext();
    if (typeof context.callGenericPopup === 'function' && context.POPUP_TYPE) {
        const result = await context.callGenericPopup(
            `<div class="pf-dialog">${title ? `<h3>${escapeHtml(title)}</h3>` : ''}${bodyHtml}</div>`,
            context.POPUP_TYPE.CONFIRM, '',
            { okButton: okText, cancelButton: '취소', customButtons: extraButtons.length ? extraButtons : null },
        );
        return result === (context.POPUP_RESULT?.AFFIRMATIVE ?? 1);
    }
    const plain = $('<div>').html(bodyHtml).text().replace(/\s+\n/g, '\n');
    return confirm(`${title}\n\n${plain}`);
}

function askConfirm(message, okText = '확인') {
    return confirmDialog('', `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`, okText);
}

// 이름 입력 창 (취소하면 null)
async function askText(message, defaultValue = '') {
    const context = getContext();
    if (typeof context.callGenericPopup === 'function' && context.POPUP_TYPE?.INPUT !== undefined) {
        const result = await context.callGenericPopup(`<div class="pf-dialog"><p>${escapeHtml(message)}</p></div>`, context.POPUP_TYPE.INPUT, defaultValue,
            { okButton: '확인', cancelButton: '취소' });
        return typeof result === 'string' ? result : null;
    }
    return prompt(message, defaultValue);
}

function listHtml(items) {
    return `<ul class="pf-dialog-list">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function downloadJson(data, fileName) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function exportFullBackup() {
    const history = await exportHistoryItems(); // 모루 남매와의 대화도 합쳐서
    downloadJson({
        type: 'persona-forge-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: exportSettingsSnapshot(),
        history,
    }, `persona-forge-backup-${new Date().toISOString().slice(0, 10)}.json`);
    showToast('success', `전체 백업을 내보냈습니다 (기록 ${history.length}개 포함).`);
}

function importFullBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data?.type !== 'persona-forge-backup' || !data.settings) {
                throw new Error('캐릭터 대장간 전체 백업 파일이 아닙니다. 기록만 가져오려면 기록 탭의 가져오기를 이용하십시오.');
            }
            const historyCount = Array.isArray(data.history) ? data.history.length : 0;
            const ok = await confirmDialog('백업 가져오기',
                `<p>${escapeHtml(file.name)}${data.exportedAt ? ` (${escapeHtml(new Date(data.exportedAt).toLocaleString('ko-KR'))})` : ''}</p>`
                + listHtml([
                    '설정 전체를 백업 내용으로 바꿉니다 (선택값, 수정한 프롬프트, 프리셋, 직접 만든 항목, 시트 양식 등)',
                    `기록은 합칩니다 — 백업의 기록 ${historyCount}개 중 지금 없는 것만 추가`,
                ]),
                '가져오기');
            if (!ok) return;
            importSettingsSnapshot(data.settings);
            const added = historyCount ? await importHistory(data.history) : 0;
            afterBulkChange();
            showToast('success', `백업을 가져왔습니다 (새 기록 ${added}개).`);
        } catch (error) {
            logError('importBackup', error);
            showToast('error', `백업 가져오기 실패: ${error.message}`);
        }
    };
    input.click();
}

function afterBulkChange() {
    wiCharKey = '';
    state.wiBooks = [];
    if (isBotMode() && !state.selectedCharKey) state.selectedCharKey = NO_CHARACTER_KEY;
    applyForgeModeUI();
    updateSettingsUI();
    populateBotPersonas();
    populateAPIProfiles();
    updateMaxTokensHint();
    populateCharacterDropdown();
    renderCardFields();
    updateHistoryUI({ refresh: true });
    updatePromptUI();
}

async function onMoreMenuAction() {
    const action = $(this).attr('data-action');
    closeMoreMenu();

    if (action === 'update-notes') {
        showUpdateNoticeOnce({ force: true });
        return;
    }
    if (action === 'export-backup') {
        await exportFullBackup();
        return;
    }
    if (action === 'import-backup') {
        importFullBackup();
        return;
    }
    if (action === 'export-history') {
        await onHistoryExport();
        return;
    }
    if (action === 'import-history') {
        onHistoryImport();
        return;
    }
    if (action === 'reset-settings') {
        const ok = await confirmDialog('설정값 초기화',
            '<p>아래 선택값만 처음 상태로 돌아갑니다.</p>'
            + listHtml(RESETTABLE_SETTING_KEYS.map(key => RESETTABLE_LABELS[key] || key))
            + '<p>유지: 기록, 수정한 프롬프트·프리셋·추가 지침, 직접 만든 항목, 자유 입력 양식, 직접 입력한 캐릭터, 캐릭터별 월드인포 선택</p>',
            '초기화');
        if (!ok) return;
        resetSettingValues();
        afterBulkChange();
        showToast('success', '설정값을 초기화했습니다.');
        return;
    }
    if (action === 'reset-history') {
        const count = (await listHistory({ refresh: true })).length;
        const ok = await confirmDialog('기록 초기화',
            `<p>저장된 기록 ${count}개를 모두 삭제합니다. 되돌릴 수 없습니다.</p><p>유지: 모든 설정과 프롬프트</p>`,
            '삭제');
        if (!ok) return;
        await clearHistory();
        updateHistoryUI();
        showToast('success', '기록을 초기화했습니다.');
        return;
    }
    if (action === 'reset-all') {
        const count = (await listHistory({ refresh: true })).length;
        const ok = await confirmDialog('전체 초기화',
            '<p>설치 직후 상태로 되돌립니다. 되돌릴 수 없으니 먼저 백업을 내보내 두십시오.</p>'
            + listHtml([
                '모든 설정값',
                '수정한 프롬프트, 프롬프트 프리셋, 추가 지침, 이전 버전 보관함',
                '직접 만든 항목과 항목 수정, 자유 입력 양식, 직접 입력한 캐릭터',
                '캐릭터별 월드인포 선택',
                `기록 ${count}개`,
            ]),
            '전체 초기화',
            [{ text: '백업 먼저 내보내기', icon: 'fa-file-export', action: () => exportFullBackup() }]);
        if (!ok) return;
        await clearHistory();
        resetAllSettings();
        state.currentGeneration = null;
        state.selectedCharKey = '';
        afterBulkChange();
        showGenerateLoading(false);
        showToast('success', '전체 초기화했습니다.');
    }
}

let previewItems = [];

async function countTokens(text) {
    try {
        const counter = getContext().getTokenCountAsync;
        if (typeof counter === 'function') return await counter(text);
    } catch { /* 추정치 사용 */ }
    return Math.ceil(text.length / 3);
}

function roleLabel(role) {
    return { system: '시스템', user: '사용자', assistant: '어시스턴트' }[role] || role;
}

async function onPreviewClick() {
    const kind = $('#pf-preview-kind').val();
    const $out = $('#pf-preview-output');
    let items;
    let note = '';

    try {
        if (kind === 'last') {
            const last = state.lastRequest;
            if (!last) throw new Error('아직 보낸 요청이 없습니다.');
            const status = { pending: '진행 중', done: '완료', truncated: '출력 한도로 끊김', error: '오류' }[last.status] || '';
            items = [{
                title: `${last.label || '요청'} · ${new Date(last.time).toLocaleTimeString('ko-KR')}`,
                meta: `${last.route} · 최대 출력 ${last.maxTokens ? last.maxTokens.toLocaleString() : '기본값'} 토큰 · ${status}`,
                messages: last.messages,
            }];
        } else {
            const result = buildPreview(kind, {
                conceptText: $('#pf-concept-text').val() || '',
                sheetTemplate: $('#pf-sheet-text').val() || '',
                instructions: $('#pf-modify-instructions').val() || '',
                targetLang: $('#pf-translate-lang').val() || '',
                greetingLanguage: $('#pf-greeting-lang').val() || '',
                greetingConcept: $('#pf-greeting-concept').val() || '',
                greetingInstructions: $('#pf-greeting-modify-instructions').val() || '',
                supportText: $('#pf-support-text').val() || '',
            });
            items = result.items;
            note = result.note;
            const connection = describeConnection();
            const meta = connection.error
                ? `⚠ ${connection.error}`
                : `${connection.label} · 최대 출력 ${connection.maxTokens ? connection.maxTokens.toLocaleString() : '기본값'} 토큰`;
            items.forEach(item => { item.meta = meta; });
        }
    } catch (error) {
        previewItems = [];
        $out.html(`<div class="pf-preview-empty">${escapeHtml(error.message)}</div>`);
        $('#pf-preview-close').show();
        return;
    }

    previewItems = items;
    $out.html('<div class="pf-preview-empty">불러오는 중...</div>');

    const blocks = [];
    for (const [idx, item] of items.entries()) {
        let totalTokens = 0;
        const messageBlocks = [];
        for (const message of item.messages) {
            const tokens = await countTokens(message.content);
            totalTokens += tokens;
            messageBlocks.push(`
                <div class="pf-preview-message">
                    <div class="pf-preview-role">${roleLabel(message.role)} <span class="pf-hint-inline">${message.content.length.toLocaleString()}자 · 약 ${tokens.toLocaleString()}토큰</span></div>
                    <pre class="pf-preview-text">${escapeHtml(message.content)}</pre>
                </div>`);
        }
        blocks.push(`
            <div class="pf-preview-item">
                <div class="pf-preview-head">
                    <div>
                        <div class="pf-preview-title">${escapeHtml(item.title)}</div>
                        <div class="pf-preview-meta">${escapeHtml(item.meta || '')} · 입력 약 ${totalTokens.toLocaleString()}토큰</div>
                    </div>
                    <button class="pf-btn pf-small-btn pf-preview-copy" data-idx="${idx}" title="이 요청 전체 복사"><i class="fa-regular fa-copy"></i> 복사</button>
                </div>
                ${messageBlocks.join('')}
            </div>`);
    }

    $out.html((note ? `<div class="pf-hint pf-preview-note">${escapeHtml(note)}</div>` : '') + blocks.join(''));
    $('#pf-preview-close').show();
}

async function onPreviewCopy() {
    const item = previewItems[Number($(this).attr('data-idx'))];
    if (!item) return;
    const text = item.messages.map(m => `### ${roleLabel(m.role)}\n${m.content}`).join('\n\n');
    const ok = await copyToClipboard(text);
    showToast(ok ? 'success' : 'error', ok ? '요청 내용을 복사했습니다.' : '복사 실패');
}
