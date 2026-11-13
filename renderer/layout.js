(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_CONFIG } = dependencies;

// Resizable panels and detachable blocks; workspace ownership stays in workspaces.js.
class CASLayoutController {
    constructor(app) {
        this.app = app;
        this.detachedBlocks = new Map();
        this.floatingWindowZ = CAS_CONFIG.UI.FLOATING_Z_INDEX;
        this.modalCloseMs = CAS_CONFIG.UI.MODAL_CLOSE_MS;
    }

    getResponsivePanelWidths(width, leftRatio = 360 / 1400, rightRatio = 340 / 1400) {
        const available = Math.max(0, width - 12);
        const minimumSide = Math.min(260, available / 4);
        const minimumCenter = Math.min(360, available / 2);
        let leftWidth = Math.max(minimumSide, width * leftRatio);
        let rightWidth = Math.max(minimumSide, width * rightRatio);
        const excess = leftWidth + rightWidth + minimumCenter - available;
        if (excess > 0) {
            const leftCapacity = leftWidth - minimumSide;
            const rightCapacity = rightWidth - minimumSide;
            const capacity = leftCapacity + rightCapacity;
            if (capacity > 0) {
                leftWidth -= excess * leftCapacity / capacity;
                rightWidth -= excess * rightCapacity / capacity;
            }
        }
        return { leftWidth, rightWidth };
    }

    setupResizers() {
        const appContainer = document.querySelector('.app-container');
        if (!appContainer) return;
        const minLeft = 260;
        const minRight = 260;
        const minCenter = 360;
        const resizerSize = 6;

        let leftRatio = 360 / 1400;
        let rightRatio = 340 / 1400;
        try {
            const saved = JSON.parse(localStorage.getItem('tsmLayout') || '{}');
            const savedViewport = Number(saved.viewportWidth) || window.innerWidth;
            const left = Number(saved.leftRatio ?? Number(saved.leftWidth) / savedViewport);
            const right = Number(saved.rightRatio ?? Number(saved.rightWidth) / savedViewport);
            if (Number.isFinite(left) && left > 0) leftRatio = left;
            if (Number.isFinite(right) && right > 0) rightRatio = right;
        } catch {}

        const constrainSizes = () => {
            // A hidden workspace has no layout box. Keep ratios valid while another tab is open.
            const width = appContainer.getBoundingClientRect().width || window.innerWidth || 1;
            const sizes = this.app.getResponsivePanelWidths(width, leftRatio, rightRatio);
            appContainer.style.setProperty('--left-width', `${sizes.leftWidth / width * 100}%`);
            appContainer.style.setProperty('--right-width', `${sizes.rightWidth / width * 100}%`);
        };
        const saveSizes = (sizes) => {
            const viewportWidth = appContainer.getBoundingClientRect().width || window.innerWidth || 1;
            leftRatio = sizes.leftWidth / viewportWidth;
            rightRatio = sizes.rightWidth / viewportWidth;
            try {
                localStorage.setItem('tsmLayout', JSON.stringify({ ...sizes, viewportWidth, leftRatio, rightRatio }));
            } catch {}
        };
        constrainSizes();

        const startDrag = (type, e) => {
            e.preventDefault();
            const rect = appContainer.getBoundingClientRect();

            const onMove = (ev) => {
                if (type === 'left') {
                    let x = ev.clientX - rect.left;
                    const rightWidth = document.querySelector('.right-panel').getBoundingClientRect().width;
                    const total = rect.width;
                    const maxLeft = total - rightWidth - 2 * resizerSize - minCenter;
                    x = Math.max(minLeft, Math.min(maxLeft, x));
                    appContainer.style.setProperty('--left-width', `${x}px`);
                } else if (type === 'right') {
                    let x = rect.right - ev.clientX;
                    const leftWidth = document.querySelector('.left-panel').getBoundingClientRect().width;
                    const total = rect.width;
                    const maxRight = total - leftWidth - 2 * resizerSize - minCenter;
                    x = Math.max(minRight, Math.min(maxRight, x));
                    appContainer.style.setProperty('--right-width', `${x}px`);
                }
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                window.removeEventListener('blur', onUp);
                const leftWidth = document.querySelector('.left-panel').getBoundingClientRect().width;
                const rightWidth = document.querySelector('.right-panel').getBoundingClientRect().width;
                const sizes = {};
                if (leftWidth) sizes.leftWidth = leftWidth;
                if (rightWidth) sizes.rightWidth = rightWidth;
                saveSizes(sizes);
                constrainSizes();
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            window.addEventListener('blur', onUp);
        };

        document.querySelectorAll('.resizer.vertical').forEach(el => {
            const type = el.dataset.resizer;
            el.addEventListener('mousedown', (e) => startDrag(type, e));
        });

        this.app.setupBlockHeightPersistence();

        window.addEventListener('resize', constrainSizes);
    }

    setupBlockHeightPersistence() {
        const resizableBlocks = [
            ['leftPlaylistsSection', '#playlistsSection'],
            ['leftPadsSection', '#soundPadsSection'],
            ['playlistsContainer', '#playlistsContainer'],
            ['soundPadsGrid', '#soundPadsGrid'],
            ['nowPlaying', '.now-playing'],
            ['volumeSection', '.volume-section'],
            ['countdownSection', '.countdown-section'],
            ['hotkeysInfo', '.hotkeys-info']
        ];

        let savedHeights = {};
        try {
            savedHeights = JSON.parse(localStorage.getItem('tsmBlockHeights') || '{}');
        } catch {}

        const saveHeights = () => {
            try {
                localStorage.setItem('tsmBlockHeights', JSON.stringify(savedHeights));
            } catch {}
        };

        const saveTimers = new Map();
        const observer = new ResizeObserver((entries) => {
            entries.forEach((entry) => {
                const key = entry.target.dataset.blockHeightKey;
                if (!key || entry.target.classList.contains('is-detached')) return;

                clearTimeout(saveTimers.get(key));
                saveTimers.set(key, setTimeout(() => {
                    if (entry.target.classList.contains('is-detached')) return;
                    const borderBox = Array.isArray(entry.borderBoxSize)
                        ? entry.borderBoxSize[0]
                        : entry.borderBoxSize;
                    const height = Math.round(borderBox?.blockSize || entry.target.getBoundingClientRect().height);
                    if (height > 40) {
                        savedHeights[key] = { height, viewportHeight: window.innerHeight };
                        if (entry.target.style.height.endsWith('px')) {
                            entry.target.style.height = `${height / window.innerHeight * 100}vh`;
                        }
                        saveHeights();
                    }
                }, 250));
            });
        });

        resizableBlocks.forEach(([key, selector]) => {
            const element = document.querySelector(selector);
            if (!element) return;

            element.dataset.blockHeightKey = key;
            const saved = savedHeights[key];
            const savedHeight = Number(saved?.height ?? saved);
            const savedViewport = Number(saved?.viewportHeight) || window.innerHeight;
            if (Number.isFinite(savedHeight) && savedHeight > 40) {
                element.style.height = `${savedHeight / savedViewport * 100}vh`;
            }
            observer.observe(element);
        });
    }

    setupDetachableBlocks() {
        this.modalCloseMs = this.app.readCssDuration('--modal-close-dur', 150);

        const detachableBlocks = [
            { key: 'playlists', selector: '#playlistsSection', title: 'Плейлисты' },
            { key: 'soundPads', selector: '#soundPadsSection', title: 'Звуковые пэды' },
            { key: 'tracks', selector: '.tracks-section', title: 'Деки и воспроизведение', fillPlaceholder: true },
            { key: 'nowPlaying', selector: '.now-playing', title: 'Сейчас играет' },
            { key: 'volume', selector: '.volume-section', title: 'Громкость' },
            { key: 'countdown', selector: '.countdown-section', title: 'Таймер' },
            { key: 'hotkeys', selector: '.hotkeys-info', title: 'Горячие клавиши' }
        ];

        detachableBlocks.forEach((definition) => {
            const block = document.querySelector(definition.selector);
            if (!block || block.dataset.detachableReady === 'true') return;

            block.classList.add('detachable-block');
            block.dataset.detachableReady = 'true';
            block.dataset.detachableKey = definition.key;
            block.dataset.detachableTitle = definition.title;

            const detachButton = document.createElement('button');
            detachButton.type = 'button';
            detachButton.className = 'block-detach-btn';
            detachButton.title = `Вынести "${definition.title}" в отдельное окно`;
            detachButton.setAttribute('aria-label', `Вынести "${definition.title}" в отдельное окно`);
            detachButton.innerHTML = '<i class="fas fa-up-right-from-square"></i>';
            detachButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.app.detachBlock(definition, block);
            });

            (block.tagName === 'DETAILS' ? block.querySelector('summary') : block).appendChild(detachButton);
        });

        window.addEventListener('resize', () => this.app.clampFloatingWindows());
    }

    readCssDuration(name, fallback) {
        const rawValue = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (!rawValue) return fallback;

        const numericValue = parseFloat(rawValue);
        if (!Number.isFinite(numericValue)) return fallback;
        return rawValue.endsWith('ms') ? numericValue : numericValue * 1000;
    }

    getFloatingWindowLayer() {
        let layer = document.querySelector('.detached-window-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'detached-window-layer';
            document.body.appendChild(layer);
        }
        return layer;
    }

    detachBlock(definition, block) {
        if (definition.key === 'appHeader' || block.classList.contains('header')) return;
        const existing = this.detachedBlocks.get(definition.key);
        if (existing) {
            this.app.bringFloatingWindowToFront(existing.windowEl);
            return;
        }

        const parent = block.parentElement;
        if (!parent) return;

        const rect = block.getBoundingClientRect();
        const placeholder = document.createElement('div');
        placeholder.className = 'detached-block-placeholder';
        if (definition.fillPlaceholder) placeholder.classList.add('is-fill');
        placeholder.innerHTML = `
            <div class="detached-placeholder-title">${definition.title}</div>
            <button type="button" class="detached-placeholder-btn">
                <i class="fas fa-window-restore"></i>
                Вернуть
            </button>
        `;
        placeholder.querySelector('.detached-placeholder-btn')?.addEventListener('click', () => {
            this.app.restoreDetachedBlock(definition.key);
        });

        parent.insertBefore(placeholder, block);

        const windowEl = document.createElement('div');
        windowEl.className = 'floating-window detached-window t-modal';
        windowEl.setAttribute('role', 'dialog');
        windowEl.setAttribute('aria-modal', 'false');
        windowEl.setAttribute('aria-label', definition.title);
        windowEl.tabIndex = -1;
        windowEl.innerHTML = `
            <div class="floating-titlebar">
                <div class="traffic-lights" aria-label="Управление окном">
                    <button type="button" class="traffic-light close" data-window-action="close" aria-label="Закрыть окно"></button>
                    <button type="button" class="traffic-light minimize" data-window-action="minimize" aria-label="Свернуть окно"></button>
                    <button type="button" class="traffic-light zoom" data-window-action="zoom" aria-label="Расширить окно"></button>
                </div>
                <div class="floating-title">${definition.title}</div>
            </div>
            <div class="floating-window-content"></div>
            <div class="floating-resize-handle" aria-hidden="true"></div>
        `;

        const content = windowEl.querySelector('.floating-window-content');
        const dockedHeight = block.style.height;
        block.style.height = '';
        content.appendChild(block);
        block.classList.add('is-detached');

        const layer = this.app.getFloatingWindowLayer();
        layer.appendChild(windowEl);
        this.app.positionFloatingWindow(windowEl, rect, definition);

        const state = { definition, block, placeholder, windowEl, dockedHeight, isClosing: false };
        this.detachedBlocks.set(definition.key, state);
        this.app.bindFloatingWindowControls(definition.key);
        this.app.bringFloatingWindowToFront(windowEl);

        requestAnimationFrame(() => {
            windowEl.classList.add('is-open');
            windowEl.focus({ preventScroll: true });
        });

        this.app.updateStatus(`${definition.title}: вынесено в окно`);
    }

    positionFloatingWindow(windowEl, rect, definition) {
        const margin = 18;
        const viewportWidth = Math.max(window.innerWidth, 1);
        const viewportHeight = Math.max(window.innerHeight, 1);
        const minWidth = definition.key === 'tracks' ? 560 : 320;
        const minHeight = definition.key === 'tracks' ? 420 : 180;
        const width = Math.min(Math.max(rect.width, minWidth), viewportWidth - margin * 2);
        const height = Math.min(Math.max(rect.height, minHeight), viewportHeight - margin * 2);
        const left = Math.min(Math.max(rect.left, margin), viewportWidth - width - margin);
        const top = Math.min(Math.max(rect.top, margin), viewportHeight - height - margin);

        this.app.setFloatingWindowGeometry(windowEl, {
            left: Math.max(margin, left),
            top: Math.max(margin, top),
            width,
            height
        });
    }

    setFloatingWindowGeometry(windowEl, geometry) {
        windowEl.style.left = `${Math.round(geometry.left)}px`;
        windowEl.style.top = `${Math.round(geometry.top)}px`;
        windowEl.style.width = `${Math.round(geometry.width)}px`;
        windowEl.style.height = `${Math.round(geometry.height)}px`;
    }

    bindFloatingWindowControls(key) {
        const state = this.detachedBlocks.get(key);
        if (!state) return;

        const { windowEl } = state;
        windowEl.addEventListener('mousedown', () => this.app.bringFloatingWindowToFront(windowEl));
        windowEl.querySelector('[data-window-action="close"]')?.addEventListener('click', () => this.app.restoreDetachedBlock(key));
        windowEl.querySelector('[data-window-action="minimize"]')?.addEventListener('click', () => this.app.toggleFloatingWindowMinimized(key));
        windowEl.querySelector('[data-window-action="zoom"]')?.addEventListener('click', () => this.app.toggleFloatingWindowMaximized(key));
        windowEl.querySelector('.floating-titlebar')?.addEventListener('mousedown', (event) => this.app.startFloatingWindowDrag(event, key));
        windowEl.querySelector('.floating-resize-handle')?.addEventListener('mousedown', (event) => this.app.startFloatingWindowResize(event, key));
    }

    bringFloatingWindowToFront(windowEl) {
        this.floatingWindowZ += 1;
        windowEl.style.zIndex = String(this.floatingWindowZ);
    }

    restoreDetachedBlock(key, { immediate = false } = {}) {
        const state = this.detachedBlocks.get(key);
        if (!state || state.isClosing) return;

        const { definition, block, placeholder, windowEl } = state;
        state.isClosing = true;

        const finishRestore = () => {
            if (placeholder.parentElement) {
                placeholder.parentElement.insertBefore(block, placeholder);
            }
            block.style.height = state.dockedHeight;
            block.classList.remove('is-detached');
            placeholder.remove();
            windowEl.remove();
            this.detachedBlocks.delete(key);
            this.app.updateStatus(`${definition.title}: возвращено на место`);
        };

        windowEl.classList.remove('is-open');
        windowEl.classList.add('is-closing');
        if (immediate) finishRestore();
        else setTimeout(finishRestore, this.modalCloseMs);
    }

    toggleFloatingWindowMinimized(key) {
        const state = this.detachedBlocks.get(key);
        if (!state) return;

        const { windowEl } = state;
        if (windowEl.classList.contains('is-minimized')) {
            windowEl.classList.remove('is-minimized');
            windowEl.style.height = state.heightBeforeMinimize || windowEl.style.height;
            windowEl.querySelector('[data-window-action="minimize"]')?.setAttribute('aria-pressed', 'false');
            return;
        }

        if (windowEl.classList.contains('is-maximized')) {
            this.app.toggleFloatingWindowMaximized(key);
        }

        state.heightBeforeMinimize = windowEl.style.height;
        windowEl.classList.add('is-minimized');
        windowEl.style.height = 'auto';
        windowEl.querySelector('[data-window-action="minimize"]')?.setAttribute('aria-pressed', 'true');
    }

    toggleFloatingWindowMaximized(key) {
        const state = this.detachedBlocks.get(key);
        if (!state) return;

        const { windowEl } = state;
        const margin = 12;

        if (windowEl.classList.contains('is-maximized')) {
            windowEl.classList.remove('is-maximized');
            if (state.geometryBeforeMaximize) {
                this.app.setFloatingWindowGeometry(windowEl, state.geometryBeforeMaximize);
            }
            windowEl.querySelector('[data-window-action="zoom"]')?.setAttribute('aria-pressed', 'false');
            return;
        }

        if (windowEl.classList.contains('is-minimized')) {
            this.app.toggleFloatingWindowMinimized(key);
        }

        const rect = windowEl.getBoundingClientRect();
        state.geometryBeforeMaximize = {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
        };

        windowEl.classList.add('is-maximized');
        this.app.setFloatingWindowGeometry(windowEl, {
            left: margin,
            top: margin,
            width: window.innerWidth - margin * 2,
            height: window.innerHeight - margin * 2
        });
        windowEl.querySelector('[data-window-action="zoom"]')?.setAttribute('aria-pressed', 'true');
    }

    startFloatingWindowDrag(event, key) {
        if (event.button !== 0 || event.target.closest('button')) return;

        const state = this.detachedBlocks.get(key);
        if (!state) return;
        const { windowEl } = state;
        if (windowEl.classList.contains('is-maximized') || windowEl.classList.contains('is-minimized')) return;

        event.preventDefault();
        this.app.bringFloatingWindowToFront(windowEl);

        const rect = windowEl.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const margin = 8;

        const onMove = (moveEvent) => {
            const width = rect.width;
            const height = rect.height;
            const left = Math.min(Math.max(moveEvent.clientX - offsetX, margin), window.innerWidth - width - margin);
            const top = Math.min(Math.max(moveEvent.clientY - offsetY, margin), window.innerHeight - 38);
            windowEl.style.left = `${Math.round(left)}px`;
            windowEl.style.top = `${Math.round(top)}px`;
            windowEl.style.width = `${Math.round(width)}px`;
            windowEl.style.height = `${Math.round(height)}px`;
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onUp);
    }

    startFloatingWindowResize(event, key) {
        if (event.button !== 0) return;

        const state = this.detachedBlocks.get(key);
        if (!state) return;
        const { windowEl } = state;
        if (windowEl.classList.contains('is-maximized') || windowEl.classList.contains('is-minimized')) return;

        event.preventDefault();
        event.stopPropagation();
        this.app.bringFloatingWindowToFront(windowEl);

        const rect = windowEl.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const minWidth = state.definition.key === 'tracks' ? 520 : 300;
        const minHeight = state.definition.key === 'tracks' ? 360 : 150;
        const margin = 10;

        const onMove = (moveEvent) => {
            const width = Math.min(Math.max(rect.width + moveEvent.clientX - startX, minWidth), window.innerWidth - rect.left - margin);
            const height = Math.min(Math.max(rect.height + moveEvent.clientY - startY, minHeight), window.innerHeight - rect.top - margin);
            windowEl.style.width = `${Math.round(width)}px`;
            windowEl.style.height = `${Math.round(height)}px`;
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onUp);
    }

    clampFloatingWindows() {
        this.detachedBlocks.forEach(({ windowEl }) => {
            if (windowEl.classList.contains('is-maximized')) {
                this.app.setFloatingWindowGeometry(windowEl, {
                    left: 12,
                    top: 12,
                    width: window.innerWidth - 24,
                    height: window.innerHeight - 24
                });
                return;
            }

            const rect = windowEl.getBoundingClientRect();
            const margin = 8;
            const width = Math.min(rect.width, window.innerWidth - margin * 2);
            const height = Math.min(rect.height, window.innerHeight - margin * 2);
            const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
            const top = Math.min(Math.max(rect.top, margin), window.innerHeight - 38);
            this.app.setFloatingWindowGeometry(windowEl, { left, top, width, height });
        });
    }
}

    return { CASLayoutController };
});
