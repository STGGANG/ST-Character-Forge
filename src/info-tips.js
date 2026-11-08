// ⓘ 툴팁 (<details class="pf-info"> + <summary> + .pf-info-bubble) — 누르면 열고, 바깥을 누르거나 Esc로 닫음. 한 번에 하나만
// 실리태번에 기대지 않는 모듈 (개발용 미리보기에서도 그대로 불러 씀)

const GAP = 8;
const MARGIN = 12;
const ARROW_INSET = 24; // 화살표를 말풍선 왼쪽 끝에서 이만큼 안쪽에 (둥근 모서리에 걸리지 않게)
const MIN_WIDTH = 160;
const MAX_WIDTH = 320;

/**
 * 말풍선 자리 — 아이콘 아래에 들어가면 아래, 아래는 모자라고 위에 들어가면 위.
 * 창 가장자리에 닿을 때만 옆으로 밀고, 화살표는 계속 아이콘을 가리킴.
 * @returns {{left: number, above: boolean, arrowX: number}} left는 ⓘ 상자 왼쪽 기준, arrowX는 말풍선 왼쪽 기준
 */
export function tipPlacement({ trigger, frame, width, height = 0 }) {
    let left = trigger.width / 2 - ARROW_INSET;
    if (trigger.left + left + width > frame.right - MARGIN) left = frame.right - MARGIN - width - trigger.left;
    if (trigger.left + left < frame.left + MARGIN) left = frame.left + MARGIN - trigger.left;
    const fitsBelow = trigger.bottom + GAP + height <= frame.bottom - GAP;
    const fitsAbove = trigger.top - GAP - height >= frame.top + GAP;
    const centre = trigger.width / 2 - left;
    return { left: Math.round(left), above: !fitsBelow && fitsAbove, arrowX: Math.round(Math.min(Math.max(centre, 16), width - 16)) };
}

function placeTip(info) {
    const frameElement = info.closest('.pf-body, .pf-container');
    if (!frameElement) return;
    const bounds = frameElement.getBoundingClientRect();
    // 아래에 붙어 있는 생성 버튼 줄은 덮지 않게 (모자라면 위로 뒤집힘)
    const bar = info.closest('.pf-tab-content')?.querySelector(':scope > .pf-generate-bar');
    const barTop = bar?.offsetParent ? bar.getBoundingClientRect().top : Infinity;
    const frame = { left: bounds.left, right: bounds.right, top: bounds.top, bottom: Math.min(bounds.bottom, barTop) };
    const trigger = info.getBoundingClientRect();
    const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, frame.width - MARGIN * 2));
    for (const bubble of info.querySelectorAll(':scope > .pf-info-bubble')) {
        // 아래쪽 기본 자리에서 잰 크기로 정함
        bubble.classList.remove('pf-tip-above');
        bubble.style.left = '';
        bubble.style.maxWidth = `${maxWidth}px`;
        const { width, height } = bubble.getBoundingClientRect();
        if (!width) continue; // 지금 모드에서 숨은 말풍선
        const placed = tipPlacement({ trigger, frame, width, height });
        bubble.style.left = `${placed.left}px`;
        bubble.style.setProperty('--pf-arrow-x', `${placed.arrowX}px`);
        bubble.classList.toggle('pf-tip-above', placed.above);
    }
}

export function closeInfoTips(root, except = null) {
    root.querySelectorAll('.pf-info[open]').forEach(info => { if (info !== except) info.open = false; });
}

// Esc — 열린 툴팁이 있으면 그것만 닫고 true (창은 그대로)
export function closeInfoTipByEscape(root) {
    const info = root.querySelector('.pf-info[open]');
    if (!info) return false;
    info.open = false;
    info.querySelector(':scope > summary')?.focus();
    return true;
}

export function bindInfoTips(root) {
    if (!root || root.pfTipsBound) return;
    root.pfTipsBound = true;
    root.addEventListener('click', event => {
        const summary = event.target.closest?.('.pf-info > summary');
        if (summary && root.contains(summary)) {
            // 직접 열고 닫아서, 그려지기 전에 자리를 맞춤 (<label> 안의 ⓘ가 스위치를 바꾸지도 않음)
            event.preventDefault();
            const info = summary.parentElement;
            const willOpen = !info.open;
            closeInfoTips(root, info);
            info.open = willOpen;
            if (willOpen) placeTip(info);
            return;
        }
        // 말풍선 글자를 눌러도 감싼 <label>의 스위치가 바뀌지 않게
        if (event.target.closest?.('.pf-info-bubble')) {
            event.preventDefault();
            return;
        }
        closeInfoTips(root);
    });
    // 모바일 사파리는 글자나 빈 곳을 탭하면 click을 보내지 않아서, 누르는 순간에도 닫음
    root.addEventListener('pointerdown', event => {
        if (!event.target.closest?.('.pf-info')) closeInfoTips(root);
    });
}
