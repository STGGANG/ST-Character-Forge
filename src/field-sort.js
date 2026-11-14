// 손잡이 없이 항목 순서 바꾸기 — 터치는 꾹 누른 뒤 끌기(그냥 밀면 스크롤), 마우스는 눌러서 끌기
// 버튼·입력칸에서 시작한 누름은 무시. 끌기를 마치면 뒤따르는 클릭(체크박스 바뀜)은 삼킴
const LONG_PRESS_MS = 350;
const MOVE_SLOP = 8; // 이만큼 움직이면 터치는 스크롤로, 마우스는 끌기로 봄
const EDGE = 48; // 스크롤 칸 위아래 이 안쪽에 오면 자동 스크롤

export function makeSortable(container, { itemSelector, ignoreSelector = 'button, input, select, textarea, a', onSort }) {
    if (!container || container.pfSortable) return;
    container.pfSortable = true;
    let press = null; // { item, pointerId, x, y, touch, timer }
    let drag = null; // { item, pointerId, lastY, scroller, frame }
    let swallowClick = false;

    const itemsOf = () => [...container.querySelectorAll(`:scope > ${itemSelector}`)];

    function cancelPress() {
        if (press?.timer) clearTimeout(press.timer);
        press = null;
    }

    function startDrag() {
        const { item, pointerId, y } = press;
        cancelPress();
        drag = { item, pointerId, lastY: y, scroller: item.closest('.pf-body') || container.parentElement, frame: 0 };
        try { container.setPointerCapture(pointerId); } catch { /* 이미 끝난 누름 */ }
        item.classList.add('pf-sorting');
        container.classList.add('pf-sorting-list');
        navigator.vibrate?.(8);
        autoScroll();
    }

    // 손가락 위치에 맞춰 항목 자리를 바꿈 (다른 항목의 가운데를 넘으면 그 앞이나 뒤로)
    function moveTo(y) {
        drag.lastY = y;
        const others = itemsOf().filter(el => el !== drag.item);
        const before = others.find(el => {
            const box = el.getBoundingClientRect();
            return y < box.top + box.height / 2;
        });
        if (before) {
            if (drag.item.nextElementSibling !== before) container.insertBefore(drag.item, before);
        } else if (container.lastElementChild !== drag.item) {
            container.append(drag.item);
        }
    }

    function autoScroll() {
        if (!drag) return;
        const box = drag.scroller.getBoundingClientRect();
        const step = drag.lastY < box.top + EDGE ? -8 : drag.lastY > box.bottom - EDGE ? 8 : 0;
        if (step) {
            drag.scroller.scrollTop += step;
            moveTo(drag.lastY);
        }
        drag.frame = requestAnimationFrame(autoScroll);
    }

    function finish(commit) {
        if (!drag) return;
        cancelAnimationFrame(drag.frame);
        drag.item.classList.remove('pf-sorting');
        container.classList.remove('pf-sorting-list');
        drag = null;
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 400);
        if (commit) onSort(itemsOf().map(el => el.getAttribute('data-field-id')));
    }

    container.addEventListener('pointerdown', event => {
        if (drag || event.button !== 0) return;
        const item = event.target.closest(itemSelector);
        if (!item || item.parentElement !== container || event.target.closest(ignoreSelector)) return;
        const touch = event.pointerType !== 'mouse';
        press = { item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, touch, timer: 0 };
        if (touch) press.timer = setTimeout(startDrag, LONG_PRESS_MS);
    });

    container.addEventListener('pointermove', event => {
        if (drag) {
            if (event.pointerId === drag.pointerId) moveTo(event.clientY);
            return;
        }
        if (!press || event.pointerId !== press.pointerId) return;
        const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_SLOP;
        if (!moved) return;
        if (press.touch) cancelPress(); // 꾹 누르기 전에 움직이면 스크롤
        else startDrag();
    });

    const end = commit => event => {
        if (press && event.pointerId === press.pointerId) cancelPress();
        if (drag && event.pointerId === drag.pointerId) finish(commit);
    };
    container.addEventListener('pointerup', end(true));
    container.addEventListener('pointercancel', end(true));
    // 끄는 동안 화면이 스크롤되지 않게 (터치)
    container.addEventListener('touchmove', event => {
        if (drag) event.preventDefault();
    }, { passive: false });
    // 꾹 누를 때 뜨는 길게 누르기 메뉴·글자 선택 막기
    container.addEventListener('contextmenu', event => {
        if (press || drag) event.preventDefault();
    });
    container.addEventListener('click', event => {
        if (!swallowClick) return;
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
    }, true);
}
