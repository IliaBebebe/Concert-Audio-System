/* Workspace changes move existing DOM nodes; players and listeners stay alive. */
class CASWorkspaceLayout {
    constructor(keys, saved) {
        this.keys = [...new Set(keys)];
        this.tabs = [{ id: 'main', title: 'Основная', blocks: [] }];
        const assigned = new Set();
        if (saved?.version === 1 && Array.isArray(saved.tabs)) {
            const candidates = [...saved.tabs].sort((a, b) => (a?.id === 'main' ? -1 : b?.id === 'main' ? 1 : 0));
            const ids = new Set();
            for (const tab of candidates) {
                if (!tab || typeof tab.id !== 'string' || ids.has(tab.id)) continue;
                if (tab.id !== 'main' && (!/^tab-[a-z0-9-]{1,70}$/.test(tab.id) || this.tabs.length >= 12)) continue;
                ids.add(tab.id);
                const normalized = tab.id === 'main' ? this.tabs[0] : { id: tab.id, title: '', blocks: [] };
                normalized.title = tab.id === 'main' ? 'Основная' : String(tab.title || 'Вкладка').trim().slice(0, 40) || 'Вкладка';
                for (const key of Array.isArray(tab.blocks) ? tab.blocks : []) {
                    if (this.keys.includes(key) && !assigned.has(key)) {
                        normalized.blocks.push(key);
                        assigned.add(key);
                    }
                }
                if (tab.id !== 'main') this.tabs.push(normalized);
            }
        }
        this.tabs[0].blocks.push(...this.keys.filter(key => !assigned.has(key)));
        this.activeTab = this.tabs.some(tab => tab.id === saved?.activeTab) ? saved.activeTab : 'main';
    }

    owner(key) { return this.tabs.find(tab => tab.blocks.includes(key))?.id; }
    activate(id) {
        if (!this.tabs.some(tab => tab.id === id)) return false;
        this.activeTab = id;
        return true;
    }
    add(id) {
        if (this.tabs.length >= 12 || !/^tab-[a-z0-9-]{1,70}$/.test(id) || this.tabs.some(tab => tab.id === id)) return false;
        this.tabs.push({ id, title: `Вкладка ${this.tabs.length + 1}`, blocks: [] });
        this.activeTab = id;
        return true;
    }
    rename(id, title) {
        const tab = this.tabs.find(tab => tab.id === id);
        if (!tab || id === 'main' || typeof title !== 'string' || !title.trim()) return false;
        tab.title = title.trim().slice(0, 40);
        return true;
    }
    move(key, destination, beforeKey) {
        const source = this.tabs.find(tab => tab.blocks.includes(key));
        const target = this.tabs.find(tab => tab.id === destination);
        if (!source || !target || beforeKey === key || (beforeKey && !target.blocks.includes(beforeKey))) return false;
        source.blocks.splice(source.blocks.indexOf(key), 1);
        const index = beforeKey ? target.blocks.indexOf(beforeKey) : target.blocks.length;
        target.blocks.splice(index, 0, key);
        return true;
    }
    remove(id) {
        const index = this.tabs.findIndex(tab => tab.id === id);
        if (index <= 0) return false;
        this.tabs[0].blocks.push(...this.tabs[index].blocks);
        this.tabs.splice(index, 1);
        if (this.activeTab === id) this.activeTab = 'main';
        return true;
    }
    serialize() { return { version: 1, activeTab: this.activeTab, tabs: this.tabs.map(tab => ({ ...tab, blocks: [...tab.blocks] })) }; }
}

class CASWorkspaceController {
    constructor(mixer) {
        this.mixer = mixer;
        this.blocks = new Map();
        this.boards = new Map([['main', document.getElementById('workspace-panel-main')]]);
        this.tablist = document.getElementById('workspaceTabs');
        this.panels = document.getElementById('workspacePanels');
        this.logo = document.querySelector('.left-panel > .header');
        this.logoHome = document.createComment('pinned-logo-home');
        this.logo.before(this.logoHome);
        this.logoSlot = document.createElement('div');
        this.logoSlot.className = 'workspace-pinned-logo';
        this.logoSlot.hidden = true;
        this.panels.appendChild(this.logoSlot);
        const syncLogoWidth = () => this.panels.style.setProperty('--workspace-left-width', getComputedStyle(this.boards.get('main')).getPropertyValue('--left-width') || '26%');
        syncLogoWidth();
        window.addEventListener('resize', syncLogoWidth);
        this.draggedKey = null;
        let saved;
        try { saved = JSON.parse(localStorage.getItem('casWorkspacesV1') || 'null'); } catch {}
        document.querySelectorAll('[data-detachable-key]').forEach(block => {
            const key = block.dataset.detachableKey;
            const marker = document.createComment(`workspace-home:${key}`);
            block.before(marker);
            const returnButton = document.createElement('button');
            returnButton.type = 'button';
            returnButton.className = 'workspace-home-placeholder';
            returnButton.textContent = `${block.dataset.detachableTitle} — вернуть сюда`;
            returnButton.addEventListener('click', () => this.move(key, 'main'));
            this.blocks.set(key, { block, marker, returnButton, title: block.dataset.detachableTitle });
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = 'block-move-btn';
            handle.draggable = true;
            handle.title = `Перетащить «${block.dataset.detachableTitle}» на вкладку или нажать для переноса`;
            handle.setAttribute('aria-label', `Перенести блок «${block.dataset.detachableTitle}»`);
            handle.innerHTML = '<i class="fas fa-grip-vertical" aria-hidden="true"></i>';
            handle.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.openTransfer(key, handle);
            });
            handle.addEventListener('dragstart', event => {
                this.closeTransfer();
                this.draggedKey = key;
                event.dataTransfer.setData('application/x-cas-block', key);
                event.dataTransfer.effectAllowed = 'move';
                document.body.classList.add('workspace-dragging');
            });
            handle.addEventListener('dragend', () => this.clearDrag());
            (block.tagName === 'DETAILS' ? block.querySelector('summary') : block).appendChild(handle);
        });
        this.layout = new CASWorkspaceLayout([...this.blocks.keys()], saved);
        this.settingsPanel = document.getElementById('workspace-panel-settings');
        this.settingsBtn = document.getElementById('openSettings');
        this.isSettingsOpen = false;

        this.settingsBtn?.addEventListener('click', () => {
            if (this.isSettingsOpen) {
                this.deactivateSettings();
            } else {
                this.activateSettings();
            }
        });

        document.getElementById('closeSettingsBtn')?.addEventListener('click', () => {
            this.deactivateSettings();
        });

        const main = this.boards.get('main');
        this.bindDrop(main, () => 'main');
        const add = document.getElementById('workspaceAdd');
        add.addEventListener('click', () => { const id = this.addTab(); if (id) this.renameDialog(id); });
        this.bindDrop(add, () => this.addTab());
        document.getElementById('workspaceRename').addEventListener('click', () => this.renameDialog(this.layout.activeTab));
        document.getElementById('workspaceDelete').addEventListener('click', () => this.deleteTab(this.layout.activeTab));
        this.tablist.addEventListener('keydown', event => {
            if (event.target.classList.contains('workspace-tab-close')) {
                if (event.key === ' ' || event.key === 'Enter') {
                    event.stopPropagation();
                }
                return;
            }
            const tab = event.target.closest('[role="tab"]');
            if (!tab) return;
            const index = this.layout.tabs.findIndex(item => item.id === tab.dataset.tabId);
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % this.layout.tabs.length;
            if (event.key === 'ArrowLeft') next = (index + this.layout.tabs.length - 1) % this.layout.tabs.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = this.layout.tabs.length - 1;
            if (next !== undefined) {
                event.preventDefault();
                event.stopPropagation();
                this.activate(this.layout.tabs[next].id, true);
            }
        });
        document.getElementById('workspaceNameForm').addEventListener('submit', event => {
            event.preventDefault();
            if (this.layout.rename(this.renamingId, document.getElementById('workspaceName').value)) {
                document.getElementById('workspaceDialog').close();
                this.render();
                this.persist();
                this.focusTab();
            }
        });
        document.getElementById('workspaceDialogCancel').addEventListener('click', () => document.getElementById('workspaceDialog').close());
        document.addEventListener('pointerdown', event => {
            if (this.transfer && !this.transfer.contains(event.target) && event.target !== this.transferTrigger) this.closeTransfer();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.transfer) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const trigger = this.transferTrigger;
                this.closeTransfer();
                trigger?.focus();
            }
        }, true);
        this.render();
    }

    persist() {
        try { localStorage.setItem('casWorkspacesV1', JSON.stringify(this.layout.serialize())); }
        catch { this.mixer.updateStatus('Не удалось сохранить раскладку вкладок', 'warning'); }
    }
    focusTab() { document.getElementById(`workspace-tab-${this.layout.activeTab}`)?.focus(); }
    addTab() {
        const id = `tab-${crypto.randomUUID()}`;
        if (!this.layout.add(id)) return null;
        this.render();
        this.persist();
        return id;
    }
    activate(id, focus = false) {
        if (this.isSettingsOpen) {
            this.isSettingsOpen = false;
            if (this.settingsPanel) this.settingsPanel.hidden = true;
            if (this.settingsBtn) {
                this.settingsBtn.classList.remove('active');
                this.settingsBtn.setAttribute('aria-selected', 'false');
            }
        }
        if (!this.layout.activate(id)) return;
        this.closeTransfer();
        this.render();
        this.persist();
        if (focus) this.focusTab();
        requestAnimationFrame(() => this.mixer.drawWaveform());
    }
    activateSettings() {
        this.isSettingsOpen = true;
        this.closeTransfer();
        for (const board of this.boards.values()) {
            board.hidden = true;
        }
        if (this.settingsPanel) this.settingsPanel.hidden = false;
        if (this.settingsBtn) {
            this.settingsBtn.classList.add('active');
            this.settingsBtn.setAttribute('aria-selected', 'true');
        }
        this.tablist.querySelectorAll('.workspace-tab').forEach(t => {
            t.setAttribute('aria-selected', 'false');
            t.tabIndex = -1;
        });
        if (this.mixer) this.mixer.updateStatus('Открыты настройки Concert Audio System');
        if (typeof window !== 'undefined' && window.lucide) {
            window.lucide.createIcons();
        }
    }
    deactivateSettings() {
        if (!this.isSettingsOpen) return;
        this.isSettingsOpen = false;
        if (this.settingsPanel) this.settingsPanel.hidden = true;
        if (this.settingsBtn) {
            this.settingsBtn.classList.remove('active');
            this.settingsBtn.setAttribute('aria-selected', 'false');
        }
        this.activate(this.layout.activeTab || 'main', true);
        if (this.mixer) this.mixer.updateStatus('Готов к работе');
    }
    reveal(key) {
        const owner = this.layout.owner(key);
        const changed = Boolean(owner && owner !== this.layout.activeTab);
        if (changed) this.activate(owner);
        return changed;
    }
    move(key, destination, beforeKey) {
        if (this.mixer.detachedBlocks.get(key)?.isClosing) return false;
        if (!this.layout.move(key, destination, beforeKey)) return false;
        this.mixer.restoreDetachedBlock(key, { immediate: true });
        this.layout.activate(destination);
        this.closeTransfer();
        this.render();
        this.persist();
        this.mixer.updateStatus(`${this.blocks.get(key).title}: перенесено во вкладку «${this.layout.tabs.find(tab => tab.id === destination).title}»`);
        requestAnimationFrame(() => this.mixer.drawWaveform());
        return true;
    }
    deleteTab(id) {
        const keys = this.layout.tabs.find(tab => tab.id === id)?.blocks || [];
        if (id === 'main' || keys.some(key => this.mixer.detachedBlocks.get(key)?.isClosing)) return;
        for (const key of keys) this.mixer.restoreDetachedBlock(key, { immediate: true });
        if (!this.layout.remove(id)) return;
        this.render();
        this.persist();
        this.focusTab();
        this.mixer.updateStatus('Вкладка удалена, её блоки возвращены на Основную');
    }
    renameDialog(id) {
        if (id === 'main') return;
        this.renamingId = id;
        const input = document.getElementById('workspaceName');
        input.value = this.layout.tabs.find(tab => tab.id === id).title;
        document.getElementById('workspaceDialog').showModal();
        input.select();
    }
    openTransfer(key, trigger) {
        this.closeTransfer();
        const popover = document.createElement('div');
        popover.className = 'workspace-transfer-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', `Перенести: ${this.blocks.get(key).title}`);
        const label = document.createElement('label');
        label.textContent = 'Перенести во вкладку';
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Вкладка назначения');
        for (const tab of this.layout.tabs) select.add(new Option(tab.title, tab.id));
        select.add(new Option('Новая вкладка…', 'new'));
        select.value = this.layout.owner(key);
        label.appendChild(select);
        const move = document.createElement('button');
        move.type = 'button';
        move.className = 'toolbar-button';
        move.textContent = 'Перенести';
        move.addEventListener('click', () => {
            const destination = select.value === 'new' ? this.addTab() : select.value;
            if (destination && this.move(key, destination)) this.focusTab();
        });
        popover.append(label, move);
        document.body.appendChild(popover);
        const rect = trigger.getBoundingClientRect();
        popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 256))}px`;
        popover.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - 140))}px`;
        this.transfer = popover;
        this.transferTrigger = trigger;
        trigger.setAttribute('aria-expanded', 'true');
        select.focus();
    }
    closeTransfer() {
        this.transfer?.remove();
        this.transferTrigger?.setAttribute('aria-expanded', 'false');
        this.transfer = null;
        this.transferTrigger = null;
    }
    bindDrop(target, destination) {
        target.addEventListener('dragover', event => {
            if (!this.draggedKey) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            target.classList.add('workspace-drop-target');
        });
        target.addEventListener('dragleave', event => {
            if (!target.contains(event.relatedTarget)) target.classList.remove('workspace-drop-target');
        });
        target.addEventListener('drop', event => {
            if (!this.draggedKey || event.dataTransfer.getData('application/x-cas-block') !== this.draggedKey) return;
            event.preventDefault();
            event.stopPropagation();
            const before = event.target.closest('[data-detachable-key]');
            const id = destination();
            if (id) this.move(this.draggedKey, id, id !== 'main' && before?.parentElement === target ? before.dataset.detachableKey : undefined);
            this.clearDrag();
        });
    }
    clearDrag() {
        this.draggedKey = null;
        document.body.classList.remove('workspace-dragging');
        document.querySelectorAll('.workspace-drop-target').forEach(node => node.classList.remove('workspace-drop-target'));
    }
    createBoard(tab) {
        const board = document.createElement('div');
        board.className = 'workspace-board';
        board.id = `workspace-panel-${tab.id}`;
        board.setAttribute('role', 'tabpanel');
        board.setAttribute('aria-labelledby', `workspace-tab-${tab.id}`);
        board.tabIndex = 0;
        const hint = document.createElement('div');
        hint.className = 'workspace-board-hint';
        const text = document.createElement('p');
        text.textContent = 'Перетащите блок на название вкладки или добавьте его из списка. За ручку можно менять порядок блоков.';
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Добавить блок в эту вкладку');
        select.addEventListener('change', () => { if (select.value) this.move(select.value, tab.id); });
        hint.append(text, select);
        board.appendChild(hint);
        this.bindDrop(board, () => tab.id);
        this.panels.appendChild(board);
        this.boards.set(tab.id, board);
        return board;
    }
    render() {
        const isMain = this.layout.activeTab === 'main';
        if (isMain) this.logoHome.after(this.logo);
        else this.logoSlot.appendChild(this.logo);
        this.logoSlot.hidden = isMain;
        this.tablist.replaceChildren();
        for (const tab of this.layout.tabs) {
            const button = document.createElement('button');
            button.type = 'button';
            button.id = `workspace-tab-${tab.id}`;
            button.className = 'workspace-tab';
            button.dataset.tabId = tab.id;
            button.title = tab.id === 'main' ? tab.title : `${tab.title} (двойной клик — переименовать)`;
            button.setAttribute('role', 'tab');
            const isTabActive = !this.isSettingsOpen && tab.id === this.layout.activeTab;
            button.setAttribute('aria-selected', String(isTabActive));
            button.tabIndex = isTabActive ? 0 : -1;

            const titleSpan = document.createElement('span');
            titleSpan.className = 'workspace-tab-title';
            titleSpan.textContent = tab.title;
            button.appendChild(titleSpan);

            if (tab.id !== 'main') {
                const closeBtn = document.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'workspace-tab-close';
                closeBtn.setAttribute('aria-label', `Закрыть вкладку «${tab.title}»`);
                closeBtn.title = `Закрыть вкладку «${tab.title}»`;
                closeBtn.innerHTML = '<i class="fas fa-xmark" aria-hidden="true"></i>';
                closeBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    this.deleteTab(tab.id);
                });
                button.appendChild(closeBtn);
                button.addEventListener('dblclick', (event) => {
                    if (event.target.closest('.workspace-tab-close')) return;
                    this.renameDialog(tab.id);
                });
            }

            button.addEventListener('click', (event) => {
                if (event.target.closest('.workspace-tab-close')) return;
                this.activate(tab.id, true);
            });
            this.bindDrop(button, () => tab.id);
            this.tablist.appendChild(button);
            const board = this.boards.get(tab.id) || this.createBoard(tab);
            board.hidden = this.isSettingsOpen || (tab.id !== this.layout.activeTab);
        }
        for (const [key, entry] of this.blocks) {
            if (this.layout.owner(key) === 'main') entry.returnButton.remove();
            else if (!entry.returnButton.isConnected) entry.marker.after(entry.returnButton);
            if (this.mixer.detachedBlocks.has(key)) continue;
            if (this.layout.owner(key) === 'main' && entry.block.previousSibling !== entry.marker) entry.marker.after(entry.block);
        }
        for (const tab of this.layout.tabs.filter(tab => tab.id !== 'main')) {
            const board = this.boards.get(tab.id);
            for (const key of tab.blocks) {
                if (!this.mixer.detachedBlocks.has(key)) board.appendChild(this.blocks.get(key).block);
            }
            const select = board.querySelector('.workspace-board-hint select');
            select.replaceChildren(new Option('Добавить блок…', ''));
            for (const [key, entry] of this.blocks) {
                if (!tab.blocks.includes(key)) select.add(new Option(entry.title, key));
            }
            select.disabled = select.options.length < 2;
        }
        for (const [id, board] of this.boards) {
            if (!this.layout.tabs.some(tab => tab.id === id)) { board.remove(); this.boards.delete(id); }
        }
        for (const [key, state] of this.mixer.detachedBlocks) state.windowEl.hidden = this.layout.owner(key) !== this.layout.activeTab;
        document.getElementById('workspaceRename').disabled = this.layout.activeTab === 'main';
        document.getElementById('workspaceDelete').disabled = this.layout.activeTab === 'main';
        document.getElementById('workspaceAdd').disabled = this.layout.tabs.length >= 12;
    }
}

if (typeof window !== 'undefined') window.CASWorkspaceController = CASWorkspaceController;
if (typeof module !== 'undefined' && module.exports) module.exports = { CASWorkspaceLayout };
