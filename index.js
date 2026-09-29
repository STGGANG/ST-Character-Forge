import { extensionName } from './src/constants.js';
import { log } from './src/state.js';
import { loadSettings } from './src/storage.js';
import { loadPopupHtml, addExtensionMenuButton, bindUIEvents } from './src/ui.js';

jQuery(async () => {
    loadSettings();

    const loaded = await loadPopupHtml();
    if (!loaded) {
        console.error(`[${extensionName}] Failed to load popup HTML`);
        return;
    }

    bindUIEvents();

    addExtensionMenuButton();

    log('캐릭터 대장간 초기화 완료');
});
