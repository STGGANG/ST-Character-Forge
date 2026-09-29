// 기록은 실리태번 사용자 파일(data/<사용자>/user/files/persona-forge-history.json) 하나에 저장
// - 실리태번 설정 파일(settings.json)과 분리 → 설정 저장이 가벼워짐
// - 서버에 저장되므로 PC·모바일 등 같은 실리태번에 접속하는 모든 기기에서 공유
// - 다중 사용자 실리태번이면 사용자별로 따로 저장
// - 쓰기 직전에 파일을 다시 읽어 변경을 적용 → 다른 기기에서 추가한 항목을 덮어쓰지 않음
// - 파일 저장을 쓸 수 없는 환경(구버전 등)에서는 기존처럼 확장 설정에 저장
// (화면에는 "기록"으로 표시, 코드·파일 이름은 history 유지)

import { getRequestHeaders } from "../../../../../script.js";
import { HISTORY_FILE_NAME, HISTORY_LIMIT } from './constants.js';
import { log, logError, getSettings } from './state.js';
import { saveSettings } from './storage.js';

let backend = null;
let cache = null;
let initPromise = null;
let writeQueue = Promise.resolve();

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

// 보관 개수를 넘으면 오래된 것부터 지움 — 즐겨찾기는 지우지 않음
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

async function writeFile(list) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: HISTORY_FILE_NAME, data: toBase64(JSON.stringify(list, null, 1)) }),
    });
    if (!response.ok) throw new Error(`기록 파일을 저장하지 못했습니다 (HTTP ${response.status})`);
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

export function getHistoryBackend() {
    return backend;
}

export async function listHistory({ refresh = false } = {}) {
    await init();
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

const OPTIONAL_FIELDS = ['kind', 'mode', 'refName', 'direction', 'personaId', 'greeting', 'greetings', 'worldOnly', 'supportChat', 'supportGender', 'conceptText', 'noTarget', 'favorite', 'wiNames'];

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
    await mutate(list => [entry, ...list]);
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
    let copyId = null;
    await mutate(list => {
        const source = list.find(item => item.id === id);
        if (!source) return list;
        const copy = structuredClone(source);
        copy.id = newId();
        copy.timestamp = Date.now();
        copy.name = `${source.name || 'Unnamed Persona'} (사본)`;
        delete copy.favorite;
        copyId = copy.id;
        return [copy, ...list];
    });
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
    await mutate(list => {
        const ids = new Set(list.map(item => item.id));
        const incoming = normalizeList(items).filter(item => !ids.has(item.id));
        added = incoming.length;
        return [...list, ...incoming];
    });
    return added;
}
