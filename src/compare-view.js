// 비교 창 — 다른 기록을 읽기 전용으로 띄워 봄 (AI에게는 보내지 않음)
// 넓은 화면: 대장간 창 옆에 끌어서 옮기고 크기를 바꾸는 창 / 좁은 화면: 머리줄 아래를 덮는 시트
// 띄워 둔 동안 머리줄의 '비교' 버튼으로 열고 접음
import { LANGUAGES } from './constants.js';
import { getSettings } from './state.js';
import { saveSettings } from './storage.js';
import { parseResponse, getSectionBody, headerLabel, countMainSections, textSignature } from './generator.js';

const SHEET_QUERY = '(max-width: 600px)';
const MIN_VISIBLE = 80;

let root = null;
let win = null;
let chip = null;
let current = null; // { item, viewLang, open }
let drag = null;

const isSheet = () => globalThis.matchMedia?.(SHEET_QUERY).matches;

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const RULE_LINE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

function textHtml(text) {
    const lines = String(text || '').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return lines.map(line => (RULE_LINE.test(line) ? '<hr class="pf-rule">' : escapeHtml(line))).join('\n').replace(/\n?(<hr class="pf-rule">)\n?/g, '$1');
}

function languageLabel(code) {
    return LANGUAGES[code]?.label || code || '';
}

function translationsOf(item) {
    const list = item?.translations && typeof item.translations === 'object' ? item.translations : {};
    return Object.fromEntries(Object.entries(list).filter(([, value]) => value?.text));
}

function profileHtml(item, text) {
    const whole = item.templateId === 'custom' || countMainSections(text) === 0;
    if (whole) return `<div class="pf-compare-sec"><div class="pf-compare-text">${textHtml(text)}</div></div>`;
    const sections = parseResponse(text);
    const keys = Object.keys(sections).sort((a, b) => parseInt(a.replace('section_', ''), 10) - parseInt(b.replace('section_', ''), 10));
    return keys.map(key => {
        const section = sections[key];
        if (!section) return '';
        const label = headerLabel(section.header);
        const body = textHtml(getSectionBody(section));
        if (/^#\s/.test(String(section.header || '').trim()) && !body) return `<div class="pf-compare-name">${escapeHtml(label)}</div>`;
        return `<div class="pf-compare-sec"><div class="pf-compare-label">${escapeHtml(label)}</div><div class="pf-compare-text">${body}</div></div>`;
    }).join('');
}

function render() {
    if (!win || !current) return;
    const { item } = current;
    const translations = translationsOf(item);
    const langs = Object.keys(translations);
    if (current.viewLang && !translations[current.viewLang]) current.viewLang = '';
    const viewing = current.viewLang ? translations[current.viewLang] : null;
    const text = viewing ? viewing.text : item.fullText;
    const stale = !!viewing?.source && viewing.source !== textSignature(item.fullText);
    const pills = langs.length ? `
        <span class="pf-pill-group" role="radiogroup" aria-label="보기 언어">
            <label class="pf-pill"><input type="radio" name="pf-compare-lang" value=""${viewing ? '' : ' checked'}><span>${escapeHtml(languageLabel(item.language))} · 원본</span></label>
            ${langs.map(lang => `<label class="pf-pill"><input type="radio" name="pf-compare-lang" value="${escapeHtml(lang)}"${current.viewLang === lang ? ' checked' : ''}><span>${escapeHtml(languageLabel(lang))}</span></label>`).join('')}
        </span>` : `<span class="pf-compare-badge">${escapeHtml(languageLabel(item.language))}</span>`;
    const greeting = item.mode === 'bot' && item.greeting
        ? `<div class="pf-compare-sec"><div class="pf-compare-label">그리팅</div><div class="pf-compare-text">${textHtml(item.greeting)}</div></div>` : '';
    win.querySelector('.pf-compare-title-text').textContent = item.name || item.charName || '기록';
    win.querySelector('.pf-compare-meta').innerHTML = `
        <span class="pf-compare-badge">${item.mode === 'bot' ? '봇' : '페르소나'}</span>
        ${pills}
        ${stale ? '<span class="pf-compare-stale"><i class="fa-solid fa-triangle-exclamation"></i> 원본을 고치기 전 번역</span>' : ''}
        <span class="pf-compare-readonly" title="AI에게 보내지 않습니다"><i class="fa-solid fa-lock"></i>읽기 전용</span>`;
    const body = win.querySelector('.pf-compare-body');
    body.innerHTML = profileHtml(item, text) + greeting;
    body.scrollTop = 0;
}

function sheetTop() {
    const header = root.querySelector('.pf-header');
    return header ? Math.round(header.getBoundingClientRect().bottom) : 56;
}

function clampPlace(left, top, width, height) {
    const maxLeft = window.innerWidth - MIN_VISIBLE;
    const maxTop = window.innerHeight - 48;
    return {
        left: Math.round(Math.min(Math.max(left, MIN_VISIBLE - width), maxLeft)),
        top: Math.round(Math.min(Math.max(top, 0), maxTop)),
        width: Math.round(width),
        height: Math.round(height),
    };
}

// 넓은 화면의 처음 자리 — 대장간 창 오른쪽에 들어가면 그 옆,
// 아니면 화면 오른쪽에 겹치되 대장간 머리줄(닫기·더 보기 버튼)은 가리지 않게 그 아래부터
function defaultPlace() {
    const box = root.querySelector('.pf-container')?.getBoundingClientRect();
    const header = root.querySelector('.pf-header')?.getBoundingClientRect();
    const width = Math.min(440, Math.max(320, window.innerWidth * 0.32));
    const beside = box ? box.right + 12 : Infinity;
    const fits = beside + width <= window.innerWidth - 12;
    const top = fits ? Math.max(20, box.top) : Math.max(20, (header?.bottom ?? 40) + 8);
    const height = Math.min(window.innerHeight - top - 20, 760);
    return clampPlace(fits ? beside : window.innerWidth - width - 16, top, width, height);
}

function placeWindow() {
    if (isSheet()) {
        win.style.removeProperty('left');
        win.style.removeProperty('top');
        win.style.removeProperty('width');
        win.style.removeProperty('height');
        win.style.setProperty('--pf-compare-top', `${sheetTop()}px`);
        return;
    }
    const saved = getSettings()?.compareWindow;
    const place = saved && Number.isFinite(saved.left)
        ? clampPlace(saved.left, saved.top, Math.max(300, saved.width || 0), Math.max(240, saved.height || 0))
        : defaultPlace();
    Object.assign(win.style, { left: `${place.left}px`, top: `${place.top}px`, width: `${place.width}px`, height: `${place.height}px` });
}

function rememberPlace() {
    if (isSheet() || !win || win.hidden) return;
    const box = win.getBoundingClientRect();
    const settings = getSettings();
    if (!settings) return;
    settings.compareWindow = clampPlace(box.left, box.top, box.width, box.height);
    saveSettings();
}

function updateChip() {
    if (!chip) return;
    chip.hidden = !current;
    chip.setAttribute('aria-pressed', current?.open ? 'true' : 'false');
    chip.title = current?.open ? '비교 창 접기' : '비교 창 열기 (읽기 전용)';
    root.classList.toggle('pf-comparing', !!current);
}

function show(open) {
    if (!current) return;
    current.open = open;
    win.hidden = !open;
    if (open) placeWindow();
    updateChip();
}

export function openCompare(item) {
    if (!win || !item?.fullText) return;
    const same = current?.item?.id === item.id;
    current = { item: structuredClone(item), viewLang: same ? current.viewLang : '', open: true };
    render();
    show(true);
}

export function closeCompare() {
    if (!current) return;
    current = null;
    win.hidden = true;
    updateChip();
}

// Esc — 비교 창이 열려 있으면 접기만 하고 true
export function compareHandlesEscape() {
    if (!current?.open) return false;
    show(false);
    chip?.focus();
    return true;
}

function startDrag(event) {
    if (isSheet() || event.button !== 0 || event.target.closest('button')) return;
    const box = win.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: box.left, top: box.top, width: box.width, height: box.height };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
}

function moveDrag(event) {
    if (!drag) return;
    const place = clampPlace(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y, drag.width, drag.height);
    win.style.left = `${place.left}px`;
    win.style.top = `${place.top}px`;
}

function endDrag() {
    if (!drag) return;
    drag = null;
    rememberPlace();
}

export function bindCompareView(popup) {
    if (!popup || popup.querySelector('#pf-compare')) return;
    root = popup;
    win = document.createElement('section');
    win.id = 'pf-compare';
    win.className = 'pf-compare';
    win.hidden = true;
    win.setAttribute('aria-label', '비교 (읽기 전용)');
    win.innerHTML = `
        <div class="pf-compare-head">
            <span class="pf-compare-grip" aria-hidden="true"><i class="fa-solid fa-grip-vertical"></i></span>
            <span class="pf-compare-title"><i class="fa-solid fa-table-columns"></i> <span>비교</span> · <span class="pf-compare-title-text"></span></span>
            <button class="pf-compare-min" type="button" title="접기 (머리줄의 '비교' 버튼으로 다시 열기)" aria-label="비교 창 접기"><i class="fa-solid fa-minus"></i></button>
            <button class="pf-compare-close" type="button" title="비교 닫기" aria-label="비교 닫기"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="pf-compare-meta"></div>
        <div class="pf-compare-body"></div>`;
    popup.append(win);

    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pf-compare-chip';
    chip.hidden = true;
    chip.innerHTML = '<i class="fa-solid fa-table-columns"></i><span>비교</span>';
    popup.querySelector('.pf-header-actions')?.prepend(chip);

    chip.addEventListener('click', () => show(!current?.open));
    win.querySelector('.pf-compare-min').addEventListener('click', () => show(false));
    win.querySelector('.pf-compare-close').addEventListener('click', closeCompare);
    win.addEventListener('change', event => {
        if (event.target.name !== 'pf-compare-lang' || !current) return;
        current.viewLang = event.target.value;
        render();
    });
    const head = win.querySelector('.pf-compare-head');
    head.addEventListener('pointerdown', startDrag);
    head.addEventListener('pointermove', moveDrag);
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    // 창 모서리로 크기를 바꾸면 기억 (잠깐 멈춘 뒤 한 번)
    let resizeTimer = 0;
    new ResizeObserver(() => {
        if (drag || win.hidden || isSheet()) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(rememberPlace, 400);
    }).observe(win);
    window.addEventListener('resize', () => {
        if (current?.open) placeWindow();
    });
}
