// 기록은 실리태번 사용자 파일(data/<사용자>/user/files/persona-forge-history.json) 하나에 저장
// - 실리태번 설정 파일(settings.json)과 분리 → 설정 저장이 가벼워짐
// - 서버에 저장되므로 PC·모바일 등 같은 실리태번에 접속하는 모든 기기에서 공유
// - 다중 사용자 실리태번이면 사용자별로 따로 저장
// - 쓰기 직전에 파일을 다시 읽어 변경을 적용 → 다른 기기에서 추가한 항목을 덮어쓰지 않음
// - 파일 저장을 쓸 수 없는 환경(구버전 등)에서는 기존처럼 확장 설정에 저장
// - 모루 남매와의 대화는 기록마다 작은 파일(persona-forge-chat-<기록ID>.json)로 따로 저장
//   → 대화를 저장할 때 기록 전체 파일을 다시 쓰지 않음 (기록에는 supportChatFile 표시만)
//   → 예전처럼 기록 안에 들어 있던 대화(supportChat)는 처음 한 번 옮기고, 내보내기는 다시 합쳐서 예전 형식 그대로
// (화면에는 "기록"으로 표시, 코드·파일 이름은 history 유지)

import { getRequestHeaders } from "../../../../../script.js";
import { HISTORY_FILE_NAME, HISTORY_LIMIT } from './constants.js';
import { log, logError, getSettings } from './state.js';
import { saveSettings } from './storage.js';

let backend = null;
let cache = null;
let initPromise = null;
let writeQueue = Promise.resolve();
let lastEvicted = 0; // 보관 개수를 넘어 지워진 기록 수 (화면에서 한 번 알리고 0으로)

const FILE_URL = `/user/files/${HISTORY_FILE_NAME}`;

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeList(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
        .filter(item => item && typeof item.fullText === 'string' && item.fullText.trim())
        .map(item => ({ ...item, id: item.id ? String(item.id) : newId() }))
        .filter(item => !seen.has(item.id) && seen.add(item.id))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .filter(keepWithinLimit());
}

// 보관 개수를 넘으면 오래된 것부터 지움 — 즐겨찾기는 지우지 않음 (지운 개수는 takeEvictedCount로 알림)
function keepWithinLimit() {
    let room = null;
    return (item, index, list) => {
        room ??= Math.max(0, HISTORY_LIMIT - list.filter(entry => entry.favorite).length);
        return item.favorite || room-- > 0;
    };
}

async function readFile() {
    const response = await fetch(`${FILE_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`기록 파일을 읽지 못했습니다 (HTTP ${response.status})`);
    const data = await response.json();
    return Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
}

function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

async function uploadFile(name, text, label) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, data: toBase64(text) }),
    });
    if (!response.ok) throw new Error(`${label}을 저장하지 못했습니다 (HTTP ${response.status})`);
}

async function writeFile(list) {
    await uploadFile(HISTORY_FILE_NAME, JSON.stringify(list, null, 1), '기록 파일');
}

// ===== 모루 남매와의 대화 파일 (기록마다 하나) =====
// 실리태번 파일 이름은 영문·숫자·_·-·.만 되므로 기록 ID의 다른 글자는 _로
function chatFileName(id) {
    return `persona-forge-chat-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

async function readChatFile(id) {
    const response = await fetch(`/user/files/${chatFileName(id)}?t=${Date.now()}`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`대화 파일을 읽지 못했습니다 (HTTP ${response.status})`);
    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

async function writeChatFile(id, chat) {
    await uploadFile(chatFileName(id), JSON.stringify(chat), '대화 파일');
}

async function deleteChatFile(id) {
    try {
        await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: `user/files/${chatFileName(id)}` }),
        });
    } catch (error) {
        logError('deleteChatFile', error);
    }
}

function init() {
    initPromise ??= (async () => {
        const settings = getSettings();
        const legacy = normalizeList(settings?.history);
        try {
            const fromFile = await readFile();
            if (fromFile === null && !legacy.length) {
                backend = 'file';
                cache = [];
                return;
            }
            const merged = normalizeList([...(fromFile || []), ...legacy]);
            if (legacy.length || fromFile === null) {
                await writeFile(merged);
                const check = await readFile();
                if (!Array.isArray(check) || check.length < merged.length) throw new Error('기록 파일 확인 실패');
                if (settings) {
                    settings.history = [];
                    saveSettings();
                }
                if (legacy.length) log(`History migrated to ${HISTORY_FILE_NAME}: ${legacy.length} items`);
            }
            backend = 'file';
            cache = merged;
        } catch (error) {
            logError('historyInit', error);
            log('History file storage unavailable — using extension settings');
            backend = 'settings';
            cache = legacy;
        }
    })().catch(error => {
        initPromise = null;
        throw error;
    });
    return initPromise;
}

// 새 기록을 넣으면서 보관 개수를 넘어 지워진 기록 수 — 읽으면 0으로
export function takeEvictedCount() {
    const count = lastEvicted;
    lastEvicted = 0;
    return count;
}

// 목록에 added개를 더했을 때 보관 개수 때문에 빠진 수
function countEvicted(before, added) {
    lastEvicted += Math.max(0, before + added - (cache?.length ?? 0));
}

export function getHistoryBackend() {
    return backend;
}

export async function listHistory({ refresh = false } = {}) {
    await init();
    migrateChats(); // 처음 한 번, 뒤에서 조용히 (기다리지 않음)
    if (refresh && backend === 'file') {
        try {
            cache = normalizeList(await readFile() || []);
        } catch (error) {
            logError('historyRefresh', error);
        }
    }
    return cache || [];
}

// 최신 데이터에 변경을 적용하고 저장 (순서대로 실행)
function mutate(change) {
    const run = async () => {
        await init();
        if (backend === 'file') {
            const fresh = normalizeList(await readFile() || []);
            const next = normalizeList(change(fresh));
            await writeFile(next);
            cache = next;
            // 목록에서 빠진 기록(삭제·초기화·보관 개수 초과)의 대화 파일도 지움
            const kept = new Set(next.map(item => item.id));
            const orphans = fresh.filter(item => item.supportChatFile && !kept.has(item.id));
            if (orphans.length) await Promise.all(orphans.map(item => deleteChatFile(item.id)));
        } else {
            const settings = getSettings();
            const next = normalizeList(change(normalizeList(settings.history)));
            settings.history = next;
            saveSettings();
            cache = next;
        }
        return cache;
    };
    const result = writeQueue.then(run, run);
    writeQueue = result.catch(() => {});
    return result;
}

// supportChat(모루 남매와의 대화)은 따로 — 파일로 저장하고 기록에는 supportChatFile 표시만
const OPTIONAL_FIELDS = ['kind', 'mode', 'refName', 'direction', 'personaId', 'greeting', 'greetings', 'worldOnly', 'supportGender', 'conceptText', 'noTarget', 'favorite', 'wiNames', 'customName', 'model', 'greetingModels'];

// 새 기록에 대화 붙이기 — 파일로 먼저 저장하고 표시만 남김 (파일 저장이 안 되면 예전처럼 기록 안에)
async function attachChat(entry, chat) {
    if (!Array.isArray(chat) || !chat.length) return;
    if (backend === 'file') {
        try {
            await writeChatFile(entry.id, chat);
            entry.supportChatFile = true;
            return;
        } catch (error) {
            logError('attachChat', error);
        }
    }
    entry.supportChat = structuredClone(chat);
}

// 기록 안에 들어 있는 대화를 대화 파일로 옮김 (ids가 없으면 전부) — 파일을 다시 읽어 확인한 것만 기록에서 뺌
async function moveInlineChats(ids = null) {
    if (backend !== 'file') return 0;
    const targets = (cache || []).filter(item => Array.isArray(item.supportChat) && (!ids || ids.has(item.id)));
    const moved = new Map(); // 기록 ID → 옮긴 대화 수 (0이면 빈 대화라 표시만 정리)
    for (const item of targets) {
        if (!item.supportChat.length) {
            moved.set(item.id, 0);
            continue;
        }
        try {
            await writeChatFile(item.id, item.supportChat);
            const check = await readChatFile(item.id);
            if (Array.isArray(check) && check.length === item.supportChat.length) moved.set(item.id, check.length);
        } catch (error) {
            logError('moveInlineChat', error);
        }
    }
    if (!moved.size) return 0;
    await mutate(list => list.map(item => {
        if (!moved.has(item.id) || !Array.isArray(item.supportChat)) return item;
        const next = { ...item };
        delete next.supportChat;
        if (moved.get(item.id)) next.supportChatFile = true;
        else delete next.supportChatFile;
        return next;
    }));
    return moved.size;
}

// 처음 한 번 — 예전 기록 안의 대화를 파일로 옮김 (대화를 저장하기 전에는 이 작업이 끝나기를 기다림)
let chatMigration = null;
function migrateChats() {
    chatMigration ??= moveInlineChats()
        .then(count => {
            if (count) log(`Support chats moved to separate files: ${count}`);
        })
        .catch(error => logError('migrateChats', error));
    return chatMigration;
}

// 기록의 대화 불러오기 (예전 형식이면 기록 안의 것, 새 형식이면 대화 파일)
// strict: 대화 파일을 못 읽으면 빈 대화 대신 오류로 (빈 대화로 이어 쓰면 기존 파일을 덮어쓰게 되므로)
export async function loadSupportChat(item, { strict = false } = {}) {
    if (Array.isArray(item?.supportChat)) return structuredClone(item.supportChat);
    if (!item?.supportChatFile) return [];
    try {
        return await readChatFile(item.id) || [];
    } catch (error) {
        logError('loadSupportChat', error);
        if (strict) throw error;
        return [];
    }
}

// 대화 저장 — 대화 파일만 다시 씀. 기록 전체 파일은 표시·성별이 바뀔 때만
// chat이 비어 있으면 대화 파일을 지우고 표시도 뺌
export async function saveSupportChat(id, chat, gender) {
    await init();
    await migrateChats();
    const list = Array.isArray(chat) && chat.length ? chat : null;
    const wantGender = list ? gender || '' : '';
    if (backend !== 'file') {
        return updateHistory(id, { supportChat: list || '', supportGender: wantGender });
    }
    const item = (cache || []).find(entry => entry.id === id);
    if (list) await writeChatFile(id, list);
    else if (item?.supportChatFile) await deleteChatFile(id);
    const needsEntryUpdate = !item
        || Array.isArray(item.supportChat)
        || !!item.supportChatFile !== !!list
        || (item.supportGender || '') !== wantGender;
    if (!needsEntryUpdate) return true;
    return updateHistory(id, { supportChat: '', supportChatFile: list ? true : '', supportGender: wantGender });
}

// 내보내기용 — 대화를 다시 기록 안에 합쳐 예전 형식 그대로 (옛 버전에서도 가져올 수 있게)
export async function exportHistoryItems() {
    const list = await listHistory({ refresh: true });
    const out = [];
    for (const item of list) {
        const copy = structuredClone(item);
        if (copy.supportChatFile) {
            const chat = await loadSupportChat(item, { strict: true });
            delete copy.supportChatFile;
            if (chat.length) copy.supportChat = chat;
        }
        out.push(copy);
    }
    return out;
}

export async function addHistory(data) {
    const entry = {
        id: newId(),
        name: data.name || 'Unnamed Persona',
        charName: data.charName || 'Unknown',
        charAvatar: data.charAvatar || '',
        fullText: data.fullText,
        language: data.language || 'en',
        templateId: data.templateId || 'standard',
        timestamp: Date.now(),
    };
    // 직접 입력한 캐릭터 — 불러와서 재생성·수정할 때 같은 대상 기준으로 쓰기 위해 함께 저장
    if (data.manualCharacter) entry.manualCharacter = { ...data.manualCharacter };
    // 선택 항목 (비어 있으면 저장하지 않음)
    // kind: 결과 종류 (original | translation | modified | personal) — 기록 목록 배지용, 예전 항목에는 없음
    // mode: 만든 대상 (persona | bot) / personaId: 참고한 내 페르소나 (페르소나 모드는 바탕 페르소나)
    // refName·direction·worldOnly·greeting(s): 봇 모드 정보 (greetings는 그리팅이 여러 버전일 때만)
    for (const key of OPTIONAL_FIELDS) {
        if (data[key]) entry[key] = structuredClone(data[key]);
    }
    await init();
    await attachChat(entry, data.supportChat);
    let before = 0;
    await mutate(list => {
        before = list.length;
        return [entry, ...list];
    });
    countEvicted(before, 1);
    log(`Saved to history: ${entry.name}`);
    return entry.id;
}

export async function updateHistory(id, patch) {
    let found = false;
    await mutate(list => list.map(item => {
        if (item.id !== id) return item;
        found = true;
        const next = { ...item };
        for (const [key, value] of Object.entries(patch)) {
            if (value === '' || value === null || value === undefined) delete next[key];
            else next[key] = structuredClone(value); // 화면의 대화 배열 등과 객체를 나눠 쓰지 않게
        }
        return next;
    }));
    return found;
}

// 기록 하나를 통째로 복제 — 원본은 그대로 두고 사본에서 이어 작업 (새 id·지금 시각, 즐겨찾기는 빼고)
export async function duplicateHistory(id) {
    await init();
    let copyId = null;
    let before = 0;
    const newCopyId = newId();
    // 대화 파일이 있으면 사본용으로 먼저 복사
    const original = (cache || []).find(item => item.id === id);
    if (original?.supportChatFile) {
        const chat = await loadSupportChat(original, { strict: true });
        if (chat.length) await writeChatFile(newCopyId, chat);
    }
    await mutate(list => {
        before = list.length;
        const source = list.find(item => item.id === id);
        if (!source) return list;
        const copy = structuredClone(source);
        copy.id = newCopyId;
        copy.timestamp = Date.now();
        copy.name = `${source.name || 'Unnamed Persona'} (사본)`;
        delete copy.favorite;
        copyId = copy.id;
        return [copy, ...list];
    });
    if (copyId) countEvicted(before, 1);
    return copyId;
}

export async function deleteHistory(id) {
    await mutate(list => list.filter(item => item.id !== id));
}

export async function deleteHistoryItems(ids) {
    const targets = new Set(ids.map(String));
    let removed = 0;
    await mutate(list => list.filter(item => {
        if (!targets.has(item.id)) return true;
        removed++;
        return false;
    }));
    return removed;
}

export async function clearHistory() {
    await mutate(() => []);
}

export async function importHistory(items) {
    let added = 0;
    let before = 0;
    let addedIds = new Set();
    await mutate(list => {
        before = list.length;
        const ids = new Set(list.map(item => item.id));
        const incoming = normalizeList(items).filter(item => !ids.has(item.id));
        added = incoming.length;
        addedIds = new Set(incoming.map(item => item.id));
        return [...list, ...incoming];
    });
    countEvicted(before, added);
    // 가져온 기록 안의 대화(예전 형식 백업)는 대화 파일로 옮김
    if (addedIds.size) await moveInlineChats(addedIds);
    return added;
}
