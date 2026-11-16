// 봇 결과를 월드인포 엔트리로 나누기 — 실리태번·화면에 기대지 않는 순수 함수 (테스트에서 그대로 씀)
// level 1: "# 제목"마다 / level 2: "## 항목"마다 ("# 제목" 아래 첫 "##" 전의 글은 따로 한 엔트리)
// 화면에서는 splitSections로 "# 제목" 덩어리를 만들고, 덩어리마다 "##"로 나눌지 따로 고름

const HEADER = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const SETTING_TITLE = /^(setting|world|세계관|世界観|世界观)\b/i;

function headerOf(line) {
    const match = line.match(HEADER);
    return match ? { level: match[1].length, title: match[2].trim() } : null;
}

/**
 * @returns {{ title: string, heading: string, parent: string, level: number, content: string }[]} 본문이 있는 덩어리만 (제목만 있는 줄은 빠짐)
 * title: 엔트리 이름 ("인물 · 항목"), heading: 그 덩어리를 연 제목 그대로, level: 그 제목의 단계 (0 = 첫 제목 앞의 글)
 * "##" 항목마다 나눌 때는 위의 "# 제목"을 엔트리 이름과 내용 첫 줄에 붙여, 엔트리 하나만 읽혀도 누구·어디 이야기인지 알게 함
 */
export function splitEntries(text, level = 1, fallbackTitle = '') {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const chunks = [];
    let parent = null;
    let current = { title: '', parent: '', level: 0, headers: [], lines: [] };
    const isEdge = line => !line.trim() || RULE.test(line);
    const push = () => {
        const kept = [...current.lines];
        while (kept.length && isEdge(kept.at(-1))) kept.pop(); // 앞뒤의 빈 줄·구분선(---)은 엔트리에 넣지 않음
        while (kept.length && isEdge(kept[0])) kept.shift();
        if (!kept.some(line => !isEdge(line) && !current.headers.includes(line))) return;
        const title = current.parent && current.title !== current.parent ? `${current.parent} · ${current.title}` : current.title;
        chunks.push({ title: title || fallbackTitle, heading: current.title, parent: current.parent, level: current.level, content: kept.join('\n').trim() });
    };
    for (const line of lines) {
        const header = headerOf(line);
        // 나누는 줄: level 1이면 "#"만, level 2면 "#"과 "##" (더 깊은 제목은 본문)
        if (header && header.level <= level) {
            push();
            if (header.level < level) {
                parent = { title: header.title, line };
                current = { title: header.title, parent: header.title, level: header.level, headers: [line], lines: [line] };
            } else {
                current = parent
                    ? { title: header.title, parent: parent.title, level: header.level, headers: [parent.line, line], lines: [parent.line, '', line] }
                    : { title: header.title, parent: '', level: header.level, headers: [line], lines: [line] };
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

/**
 * "# 제목"마다 한 덩어리 — 안에 나눌 "##" 항목이 있으면 parts에 (없으면 빈 배열)
 * @returns {{ title: string, parent: string, level: number, content: string, parts: object[] }[]}
 */
export function splitSections(text, fallbackTitle = '') {
    const groups = [[]];
    for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
        if (headerOf(line)?.level === 1) groups.push([]);
        groups.at(-1).push(line);
    }
    return groups.flatMap(lines => {
        const body = lines.join('\n');
        const [whole] = splitEntries(body, 1, fallbackTitle);
        if (!whole) return [];
        const parts = splitEntries(body, 2, fallbackTitle);
        return [{ ...whole, parts: parts.length > 1 ? parts : [] }];
    });
}

// 나누기로 고른 덩어리(split: 덩어리 번호 Set)는 "##" 항목들로, 나머지는 통째로 — key로 화면의 고친 값을 이어 붙임
export function sectionEntries(sections, split = new Set()) {
    return sections.flatMap((section, index) => (split.has(index) && section.parts.length
        ? section.parts.map((part, partIndex) => ({ ...part, key: `${index}.${partIndex}`, section: index, part: true, first: partIndex === 0 }))
        : [{ ...section, key: String(index), section: index }]));
}

const CLOSERS = { '【': '】', '「': '」', '『': '』', '[': ']', '<': '>', '(': ')', '（': '）', '《': '》', '〈': '〉' };

function cleanTitle(value, marker = '') {
    let title = String(value || '').replace(/^[\s#*_`>-]+|[\s#*_`]+$/g, '');
    const closer = CLOSERS[marker.at(-1)];
    if (closer && title.endsWith(closer)) title = title.slice(0, -closer.length);
    if (CLOSERS[title[0]] && title.endsWith(CLOSERS[title[0]])) title = title.slice(1, -1); // "【이름】" → "이름"
    return title.replace(/[\s:：]+$/, '').trim().slice(0, 80);
}

/**
 * 직접 적은 글자로 시작하는 줄마다 한 엔트리 — 그 줄의 나머지가 이름 ("【이름】"이면 괄호를 뺀 이름)
 * 나머지가 없는 줄("---" 같은 구분선)은 엔트리에 넣지 않고, 그 아래 첫 줄을 이름으로 씀
 * 첫 기준 줄 앞의 글은 "# 제목"으로 시작하면 그 제목이 이름, 아니면 결과 이름 (항상 켜짐)
 */
export function splitByMarker(text, marker, fallbackTitle = '') {
    const mark = String(marker || '').trim();
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const isEdge = line => !line.trim() || RULE.test(line);
    const chunks = [];
    let current = { title: '', marked: false, lines: [] };
    const push = () => {
        const kept = [...current.lines];
        while (kept.length && isEdge(kept.at(-1))) kept.pop();
        while (kept.length && isEdge(kept[0])) kept.shift();
        if (!kept.length) return;
        const named = current.marked || (!!mark && !!headerOf(kept[0])); // 기준이 비었으면 전체 한 덩어리 = 결과 이름
        const title = current.title || (named ? cleanTitle(kept[0]) : '') || fallbackTitle;
        chunks.push({ title, heading: title, parent: '', level: named ? 1 : 0, content: kept.join('\n').trim() });
    };
    for (const line of lines) {
        if (mark && line.trimStart().startsWith(mark)) {
            push();
            const title = cleanTitle(line.trimStart().slice(mark.length), mark);
            current = { title, marked: true, lines: title ? [line] : [] };
            continue;
        }
        current.lines.push(line);
    }
    push();
    return chunks;
}

// 기본값 — 세계관(Setting)은 항상 켜짐, 인물은 이름이 나올 때만 ("##" 항목은 그 위 "#" 인물 이름으로)
// 세계관만 만든 결과는 "#"이 세계 이름이라 모두 항상 켜짐, 첫 제목 앞의 글도 항상 켜짐
export function entryDefaults(chunks, { worldOnly = false } = {}) {
    return chunks.map(chunk => {
        const owner = chunk.level === 2 ? chunk.parent : chunk.level === 1 ? chunk.title : '';
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
