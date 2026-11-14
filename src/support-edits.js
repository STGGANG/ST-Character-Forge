// 모루 남매 변경안(<edit>) — 답 나누기, 지금 글에서 찾기, 항목 전체로 넓혀 비교하기
// 실리태번·화면에 기대지 않는 순수 함수만 (테스트에서 그대로 불러 씀)

const tagText = (body, name) => body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))?.[1]?.trim() || '';
// 끊긴 변경안 — 닫는 태그가 없으면 끝까지
const openTagText = (body, name) => body.match(new RegExp(`<${name}>([\\s\\S]*?)(?:</${name}>|$)`, 'i'))?.[1]?.trim() || '';
const targetOf = attrs => attrs.match(/target\s*=\s*"([^"]*)"/i)?.[1]?.trim() || '';

// 모델 답을 원래 글 조각 그대로 글과 변경안으로 나눔 — 형식이 틀리면 글로 둠
// 닫히지 않은 채 끝난 마지막 변경안은 cut: true (답이 중간에 멈춘 것 — 바로 적용은 막음)
export function splitSupportText(text) {
    const pieces = [];
    const pattern = /<edit\b([^>]*)>([\s\S]*?)<\/edit>/gi;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
        const revised = tagText(match[2], 'revised');
        if (!revised) continue;
        if (match.index > last) pieces.push({ type: 'text', raw: text.slice(last, match.index) });
        pieces.push({
            type: 'edit',
            raw: match[0],
            target: targetOf(match[1]),
            original: tagText(match[2], 'original'),
            revised,
            revisedKo: tagText(match[2], 'revised_ko'),
        });
        last = pattern.lastIndex;
    }
    const rest = text.slice(last);
    const cut = rest.match(/<edit\b([^>]*)>([\s\S]*)$/i);
    if (cut && !/<\/edit>/i.test(cut[2])) {
        if (cut.index > 0) pieces.push({ type: 'text', raw: rest.slice(0, cut.index) });
        pieces.push({
            type: 'edit',
            cut: true,
            raw: cut[0],
            target: targetOf(cut[1]),
            original: openTagText(cut[2], 'original'),
            revised: /<revised>/i.test(cut[2]) ? openTagText(cut[2], 'revised') : '',
            revisedKo: '',
        });
    } else if (rest) {
        pieces.push({ type: 'text', raw: rest });
    }
    return pieces;
}

export function hasCutEdit(text) {
    return splitSupportText(String(text || '')).some(piece => piece.cut);
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 글 위치 — 그대로 없으면 공백·줄바꿈·따옴표 모양만 달라도 찾음
// (from: 대상 섹션 제목 위치 — 같은 문장이 여러 섹션에 있으면 그 섹션 것부터)
export function locateText(text, needle, from = 0) {
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

export function sectionOffset(text, target) {
    const name = String(target || '').replace(/^#+/, '').trim();
    if (!name) return 0;
    return new RegExp(`^#{1,6}[ \\t]*${escapeRegex(name)}[ \\t]*$`, 'im').exec(text)?.index || 0;
}

// 찾은 자리 뒤로, 다음 섹션 제목 전에 같은 글이 또 있는지 (짧게 옮긴 원문이 어느 쪽인지 모를 때)
export function isAmbiguous(text, needle, place) {
    const next = locateText(text, needle, place.end);
    if (!next || next.start < place.end) return false;
    return !/^#{1,6}[ \t]/m.test(text.slice(place.end, next.start));
}

export function replaceAt(text, place, replacement) {
    return text.slice(0, place.start) + replacement + text.slice(place.end);
}

// 띄어 쓰는 글자 (단어 중간에서 강조가 끊기지 않게 단어 끝까지 넓힘) — 일본어·중국어는 글자 단위 그대로
const WORD_CHAR = /[\p{Script=Latin}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u;
const inWord = (text, index) => index > 0 && index < text.length && WORD_CHAR.test(text[index - 1]) && WORD_CHAR.test(text[index]);

// 두 글의 같은 앞부분·뒷부분 길이 — 그 사이가 바뀐 부분
export function commonEdges(a, b) {
    const limit = Math.min(a.length, b.length);
    let head = 0;
    while (head < limit && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < limit - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    while (head > 0 && (inWord(a, head) || inWord(b, head))) head--;
    while (tail > 0 && (inWord(a, a.length - tail) || inWord(b, b.length - tail))) tail--;
    return { head, tail };
}

/**
 * 변경안을 글에서 찾아, 그 부분이 든 줄(항목) 전체의 바꾸기 전·후와 바뀐 부분 위치를 돌려줌.
 * 적용 전이면 원문으로, 이미 적용했으면 대체안으로 찾음. 못 찾으면 null.
 * @returns {{ applied: boolean, before: string, after: string, beforeMark: number[], afterMark: number[] } | null}
 */
export function editContext(source, { original, revised }, from = 0) {
    original = String(original || '').trim();
    revised = String(revised || '').trim();
    if (!source || !original || !revised) return null;
    const atOriginal = locateText(source, original, from);
    const atRevised = locateText(source, revised, from);
    const within = (inner, outer) => inner && outer && inner.start >= outer.start && inner.end <= outer.end;
    // 둘 다 있으면: 원문이 대체안 안에 들어 있으면(덧붙이기) 적용 후, 그 밖에는 적용 전
    const applied = !!atRevised && (!atOriginal || (within(atOriginal, atRevised) && !within(atRevised, atOriginal)));
    const place = applied ? atRevised : atOriginal;
    if (!place) return null;

    const lineStart = source.lastIndexOf('\n', place.start - 1) + 1;
    const nextBreak = source.indexOf('\n', place.end);
    const head = source.slice(lineStart, place.start);
    const tail = source.slice(place.end, nextBreak < 0 ? source.length : nextBreak);
    const found = source.slice(place.start, place.end);
    const oldText = applied ? original : found;
    const newText = applied ? found : revised;
    const edges = commonEdges(oldText, newText);
    return {
        applied,
        before: head + oldText + tail,
        after: head + newText + tail,
        beforeMark: [head.length + edges.head, head.length + oldText.length - edges.tail],
        afterMark: [head.length + edges.head, head.length + newText.length - edges.tail],
    };
}
