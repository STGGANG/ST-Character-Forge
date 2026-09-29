// - 캐릭터에 연결된 북(기본/추가/카드 내장)은 자동 선택, 그 외 북은 목록에만 표시
// - 선택한 북만 불러옴 (전체 북을 한꺼번에 읽지 않음)
// - 선택 상태는 캐릭터별로 이 확장 설정에 저장 — 실리태번의 월드인포 활성 설정은 건드리지 않음

import { getContext } from "../../../../extensions.js";
import { getRequestHeaders } from "../../../../../script.js";
import { log } from './state.js';

export const WI_SOURCES = {
    primary: '캐릭터 기본',
    extra: '캐릭터 추가',
    embedded: '카드 내장',
    chat: '현재 채팅',
    persona: '현재 페르소나',
    global: '전역',
};

let worldModulePromise = null;
function worldModule() {
    worldModulePromise ??= import("../../../../world-info.js").catch(() => ({}));
    return worldModulePromise;
}

export const MANUAL_CHARACTER_KEY = '__manual__';

export const NO_CHARACTER_KEY = '__none__';

export function getCharacterKey(char) {
    return String(char?.avatar || char?.name || '');
}

function characterFileName(char) {
    return String(char?.avatar || '').replace(/\.[^.]+$/, '');
}

function toArray(value) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return value.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

async function fetchBookNames() {
    try {
        const response = await fetch('/api/worldinfo/list', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
        if (response.ok) {
            const data = await response.json();
            const names = Array.isArray(data) ? data : (data?.worldNames || data?.world_names || []);
            return names.map(item => typeof item === 'string' ? item : item?.file_id || item?.name).filter(Boolean);
        }
    } catch { /* 다음 방법 시도 */ }

    try {
        const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
        if (response.ok) {
            const data = await response.json();
            return Array.isArray(data?.world_names) ? data.world_names : [];
        }
    } catch { /* 무시 */ }

    return [];
}

async function discoverBooks(char, charIndex) {
    const world = await worldModule();
    const context = getContext();
    const books = new Map();

    const add = (name, source, { auto = false, embedded = null, key = `book:${name}` } = {}) => {
        if (!name) return;
        const existing = books.get(key);
        if (existing) {
            if (source && !existing.sources.includes(source)) existing.sources.push(source);
            existing.auto = existing.auto || auto;
            return;
        }
        books.set(key, { key, name: String(name), sources: source ? [source] : [], auto, embedded });
    };

    const primary = char?.data?.extensions?.world;
    add(primary, WI_SOURCES.primary, { auto: true });

    const charLore = world.world_info?.charLore?.find(item => item.name === characterFileName(char));
    for (const name of charLore?.extraBooks || []) add(name, WI_SOURCES.extra, { auto: true });

    // 외부 북이 연결되지 않은 카드만 내장 로어북 표시 (연결된 경우 대개 같은 내용을 가져온 것)
    if (!primary && char?.data?.character_book?.entries) {
        add(char.data.character_book.name || '카드 내장 로어북', WI_SOURCES.embedded, {
            auto: true,
            embedded: char.data.character_book,
            key: `embedded:${getCharacterKey(char)}`,
        });
    }

    if (context.characterId !== undefined && String(context.characterId) === String(charIndex)) {
        add(context.chatMetadata?.[world.METADATA_KEY || 'world_info'], WI_SOURCES.chat);
    }

    // 현재 페르소나의 로어북 — 기존 페르소나 설정이 섞일 수 있으므로 자동 선택하지 않음
    add(context.powerUserSettings?.persona_description_lorebook, WI_SOURCES.persona);

    for (const name of world.selected_world_info || []) add(name, WI_SOURCES.global);

    const names = Array.isArray(world.world_names) ? world.world_names : await fetchBookNames();
    for (const name of names) add(name, '');

    return [...books.values()];
}

async function loadBookData(book) {
    if (book.embedded) return book.embedded;

    const world = await worldModule();
    if (typeof world.loadWorldInfo === 'function') {
        return await world.loadWorldInfo(book.name);
    }

    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: book.name }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

function normalizeEntries(data) {
    const raw = data?.entries;
    if (!raw || typeof raw !== 'object') return [];

    const list = Array.isArray(raw) ? raw.map((entry, idx) => [String(idx), entry]) : Object.entries(raw);
    return list.map(([fallbackId, entry]) => {
        if (!entry || typeof entry !== 'object') return null;
        const uid = String(entry.uid ?? entry.id ?? fallbackId);
        const keys = toArray(entry.key ?? entry.keys);
        return {
            uid,
            name: String(entry.comment || entry.name || keys.join(', ') || `이름 없는 항목 #${uid}`),
            keys,
            content: typeof entry.content === 'string' ? entry.content.trim() : '',
            enabled: entry.disable !== true && entry.disabled !== true && entry.enabled !== false,
            constant: !!entry.constant,
        };
    }).filter(Boolean);
}

function getStoredSelection(settings, charKey) {
    return settings?.wiSelections?.[charKey] || { books: {}, entries: {} };
}

function ensureStoredSelection(settings, charKey) {
    settings.wiSelections ||= {};
    const store = settings.wiSelections[charKey] ||= {};
    store.books ||= {};
    store.entries ||= {};
    return store;
}

export async function loadBookEntries(book, settings, charKey) {
    book.error = '';
    try {
        const data = await loadBookData(book);
        if (!data?.entries) throw new Error('삭제되었거나 읽을 수 없는 월드인포입니다.');
        const stored = getStoredSelection(settings, charKey).entries?.[book.key] || {};
        // 저장된 선택이 없으면 실리태번에서 켜져 있는 항목만 선택
        book.entries = normalizeEntries(data).map(entry => ({
            ...entry,
            selected: !!entry.content && (stored[entry.uid] ?? entry.enabled),
        }));
        book.loaded = true;
    } catch (error) {
        book.entries = [];
        book.loaded = false;
        book.error = error.message || String(error);
    }
    return book;
}

export async function readCharacterWorldInfo(charIndex, settings) {
    const manual = charIndex === MANUAL_CHARACTER_KEY || charIndex === NO_CHARACTER_KEY;
    const char = manual ? null : getContext().characters?.[charIndex];
    if (!char && !manual) return { charKey: '', books: [] };

    // 직접 입력 / 캐릭터 없음: 연결된 북이 없으므로 전체 목록에서 직접 고름
    const charKey = manual ? charIndex : getCharacterKey(char);
    const stored = getStoredSelection(settings, charKey);
    const books = [];

    for (const found of await discoverBooks(char, manual ? -1 : charIndex)) {
        const book = { ...found, selected: stored.books?.[found.key] ?? found.auto, loaded: false, error: '', entries: [] };
        if (book.selected) await loadBookEntries(book, settings, charKey);
        books.push(book);
    }

    const loaded = books.filter(b => b.loaded);
    log(`World info: ${books.length} books listed, ${loaded.length} loaded (${loaded.reduce((n, b) => n + b.entries.length, 0)} entries)`);
    return { charKey, books };
}

export function storeBookSelected(settings, charKey, bookKey, selected) {
    ensureStoredSelection(settings, charKey).books[bookKey] = !!selected;
}

export function storeEntrySelected(settings, charKey, bookKey, uid, selected) {
    const store = ensureStoredSelection(settings, charKey);
    store.entries[bookKey] ||= {};
    store.entries[bookKey][uid] = !!selected;
}

// 실제로 참고한 북 이름 (고른 항목이 있는 북만)
export function getSelectedBookNames(books) {
    return (books || [])
        .filter(book => book.selected && book.loaded && book.entries.some(entry => entry.selected && entry.content))
        .map(book => book.name);
}

export function getSelectedEntries(books) {
    return (books || [])
        .filter(book => book.selected && book.loaded)
        .flatMap(book => book.entries.filter(entry => entry.selected && entry.content));
}
