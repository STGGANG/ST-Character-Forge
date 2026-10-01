import { extensionName } from './src/constants.js';
import { log } from './src/state.js';
import { loadSettings } from './src/storage.js';
import { loadPopupHtml, addExtensionMenuButton, bindUIEvents } from './src/ui.js';

// 같은 확장이 두 번 설치된 경우 (예: 예전 '페르소나 대장간'과 함께) — 창이 둘 생기고 버튼이 두 번씩 반응해
// 엉뚱한 확인 창이 뜨거나 요청이 두 번 갈 수 있음
const DUPLICATE_MESSAGE = '캐릭터 대장간이 두 번 설치되어 있습니다 (예전 \'페르소나 대장간\' 포함). 버튼이 두 번씩 반응하는 등 오류가 생길 수 있으니, 실리태번 확장 관리에서 하나를 지워 주십시오.';

function warnDuplicate() {
    console.warn(`[${extensionName}] ${DUPLICATE_MESSAGE}`);
    globalThis.toastr?.warning(DUPLICATE_MESSAGE, '캐릭터 대장간', { timeOut: 15000 });
}

jQuery(async () => {
    // 먼저 뜬 쪽만 씀 (이 버전이 나중에 뜬 경우)
    if (globalThis.__characterForgeLoaded || document.getElementById('persona-forge-popup')) {
        warnDuplicate();
        return;
    }
    globalThis.__characterForgeLoaded = true;

    loadSettings();

    const loaded = await loadPopupHtml();
    if (!loaded) {
        console.error(`[${extensionName}] Failed to load popup HTML`);
        return;
    }

    bindUIEvents();

    addExtensionMenuButton();

    log('캐릭터 대장간 초기화 완료');

    // 이 버전이 먼저 뜨고 예전 버전이 뒤에 뜬 경우 (예전 버전은 이 확인을 하지 않음)
    setTimeout(() => {
        if (document.querySelectorAll('#persona-forge-popup').length > 1) warnDuplicate();
    }, 5000);
});
