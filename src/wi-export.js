// 봇 결과를 월드인포 엔트리로 나누기 — 실리태번·화면에 기대지 않는 순수 함수 (테스트에서 그대로 씀)
// level 1: "# 제목"마다 / level 2: "## 항목"마다 ("# 제목" 아래 첫 "##" 전의 글은 따로 한 엔트리)

const HEADER = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const SETTING_TITLE = /^(setting|world|세계관|世界観|世界观)\b/i;

function headerOf(line) {
    const match = line.match(HEADER);
    return match ? { level: match[1].length, title: match[2].trim() } : null;
}

/**
 * @returns {{ title: string, parent: string, content: string }[]} 본문이 있는 덩어리만 (제목만 있는 줄은 빠짐)
 * "##" 항목마다 나눌 때는 위의 "# 제목"을 엔트리 이름과 내용 첫 줄에 붙여, 엔트리 하나만 읽혀도 누구·어디 이야기인지 알게 함
 */
export function splitEntries(text, level = 1, fallbackTitle = '') {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const chunks = [];
    let parent = null;
    let current = { title: '', parent: '', headers: [], lines: [] };
    const isEdge = line => !line.trim() || RULE.test(line);
    const push = () => {
        const kept = [...current.lines];
        while (kept.length && isEdge(kept.at(-1))) kept.pop(); // 앞뒤의 빈 줄·구분선(---)은 엔트리에 넣지 않음
        while (kept.length && isEdge(kept[0])) kept.shift();
        if (!kept.some(line => !isEdge(line) && !current.headers.includes(line))) return;
        const title = current.parent && current.title !== current.parent ? `${current.parent} · ${current.title}` : current.title;
        chunks.push({ title: title || fallbackTitle, parent: current.parent, content: kept.join('\n').trim() });
    };
    for (const line of lines) {
        const header = headerOf(line);
        // 나누는 줄: level 1이면 "#"만, level 2면 "#"과 "##" (더 깊은 제목은 본문)
        if (header && header.level <= level) {
            push();
            if (header.level < level) {
                parent = { title: header.title, line };
                current = { title: header.title, parent: header.title, headers: [line], lines: [line] };
            } else {
                current = parent
                    ? { title: header.title, parent: parent.title, headers: [parent.line, line], lines: [parent.line, '', line] }
                    : { title: header.title, parent: '', headers: [line], lines: [line] };
            }
            continue;
        }
        current.lines.push(line);
    }
    push();
    return chunks;
}

// 제목에서 키워드 — "이름 (다른 표기)"면 둘 다
export function keysFromTitle(title) {
    const clean = String(title || '').replace(/[*_`]/g, '').trim();
    const keys = [];
    const outside = clean.replace(/\s*[(（][^)）]*[)）]\s*/g, ' ').trim();
    if (outside) keys.push(outside);
    for (const match of clean.matchAll(/[(（]([^)）]+)[)）]/g)) {
        for (const part of match[1].split(/[,，、/]/)) if (part.trim()) keys.push(part.trim());
    }
    return [...new Set(keys)];
}

// 기본값 — 세계관(Setting)은 항상 켜짐, 인물은 이름이 나올 때만 ("##"로 나누면 그 위 "#" 인물 이름으로)
// 세계관만 만든 결과는 "#"이 세계 이름이라 모두 항상 켜짐
export function entryDefaults(chunks, level = 1, { worldOnly = false } = {}) {
    return chunks.map(chunk => {
        const owner = level === 1 ? chunk.title : chunk.parent;
        const constant = chunks.length === 1 || worldOnly || !owner || SETTING_TITLE.test(owner);
        return { ...chunk, include: true, constant, keys: constant ? [] : keysFromTitle(owner) };
    });
}

// 이름 줄이 없는 결과의 북 이름 — 세계관이 아닌 첫 "#" 제목 (괄호 속 읽는 법은 뺌)
export function firstEntryName(text) {
    const chunk = splitEntries(text, 1).find(({ title }) => title && !SETTING_TITLE.test(title));
    return chunk ? keysFromTitle(chunk.title)[0] || '' : '';
}

// 북 이름 — 파일 이름에 못 쓰는 글자를 빼고, 이미 있으면 " (2)"처럼 붙임
export function sanitizeBookName(name) {
    return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

export function uniqueBookName(name, existing = []) {
    const taken = new Set(existing.map(value => String(value).toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 1000; n++) {
        const next = `${name} (${n})`;
        if (!taken.has(next.toLowerCase())) return next;
    }
    return `${name} ${Date.now()}`;
}
