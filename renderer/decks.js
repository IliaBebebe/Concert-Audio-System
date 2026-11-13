(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(Object.assign({},
            require('./config.js'),
            require('./deck-manager.js')
        ));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CASDeckManager } = dependencies;

// Deck views, queue selection, filtering and drag-and-drop transfers.
class CASDecksController {
    constructor(app) {
        this.app = app;
        this.deckManager = new CASDeckManager();
        this.decks = this.deckManager.decks;
    }

    displayTracks(targetDeckId = null) {
        const decksToRender = targetDeckId ? [targetDeckId] : ['A', 'B'];

        decksToRender.forEach((deckId) => {
            const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
            const container = document.getElementById(containerId);
            if (!container) return;
            container.replaceChildren();

            const deck = this.decks[deckId];
            if (!deck) return;
            const filterQuery = (deck.filterQuery || '').toLowerCase().trim();
            const tracks = deck.tracks || [];

            const list = tracks
                .map((t, i) => ({ t, i }))
                .filter(({ t }) => {
                    if (!filterQuery) return true;
                    const name = (t.name || '').toLowerCase();
                    const title = (t.title || '').toLowerCase();
                    const artist = (t.artist || '').toLowerCase();
                    const trackNumber = String(t.trackNumber || '');
                    return name.includes(filterQuery)
                        || title.includes(filterQuery)
                        || artist.includes(filterQuery)
                        || trackNumber.includes(filterQuery);
                });

            const fragment = document.createDocumentFragment();
            const pendingTrackLoads = [];
            const isDragEnabled = !filterQuery;

            if (list.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'deck-empty-state';
                const title = document.createElement('strong');
                title.textContent = filterQuery ? 'Ничего не найдено' : `Дека ${deckId} готова к загрузке`;
                const hint = document.createElement('span');
                hint.textContent = filterQuery ? 'Измените запрос или очистите поиск' : 'Выберите эту деку, затем плейлист слева';
                empty.append(title, hint);
                if (filterQuery) {
                    const clear = document.createElement('button');
                    clear.type = 'button';
                    clear.className = 'deck-empty-action';
                    clear.textContent = 'Очистить поиск';
                    clear.addEventListener('click', () => {
                        const search = document.getElementById(`trackSearchInput${deckId}`);
                        if (search) search.value = '';
                        this.app.filterTracksInDeck(deckId, '');
                        search?.focus();
                    });
                    empty.appendChild(clear);
                }
                fragment.appendChild(empty);
            }

            list.forEach(({ t: track, i: index }) => {
                const row = document.createElement('div');
                row.className = 'track-row';
                row.dataset.index = String(index);
                row.dataset.deck = deckId;
                row.addEventListener('keydown', (event) => {
                    if (!event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code) || !isDragEnabled) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
                        const targetIndex = index + (event.code === 'ArrowUp' ? -1 : 1);
                        const result = this.app.moveTrackBetweenDecks(deckId, index, deckId, targetIndex, event.code === 'ArrowDown');
                        if (!result) return;
                        document.querySelector(`#${containerId} .track-btn[data-index="${result.insertAt}"]`)?.focus();
                    } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
                        const otherDeckId = deckId === 'A' ? 'B' : 'A';
                        const result = this.app.moveTrackBetweenDecks(deckId, index, otherDeckId, null, true);
                        if (!result) return;
                        const otherContainerId = otherDeckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
                        document.querySelector(`#${otherContainerId} .track-btn[data-index="${result.insertAt}"]`)?.focus();
                    }
                });

                // Drag handle
                const dragHandle = document.createElement('div');
                dragHandle.className = 'track-drag-handle';
                dragHandle.innerHTML = '<svg class="lucide lucide-grip-vertical" data-lucide="grip-vertical" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>';
                dragHandle.setAttribute('aria-hidden', 'true');

                if (isDragEnabled) {
                    row.draggable = true;
                    row.addEventListener('dragstart', (e) => this.app.handleTrackDragStart(e, deckId, index));
                    row.addEventListener('dragover', (e) => this.app.handleTrackDragOver(e, deckId));
                    row.addEventListener('dragenter', (e) => this.app.handleTrackDragEnter(e, row));
                    row.addEventListener('dragleave', (e) => this.app.handleTrackDragLeave(e, row));
                    row.addEventListener('drop', (e) => {
                        e.stopPropagation();
                        this.app.handleTrackDrop(e, deckId, index);
                    });
                    row.addEventListener('dragend', (e) => this.app.handleTrackDragEnd(e));
                } else {
                    dragHandle.style.opacity = '0.15';
                    dragHandle.style.cursor = 'default';
                }

                const displayName = this.app.getTrackDisplayName(track, index);
                const btn = document.createElement('button');
                btn.className = 'track-btn';
                btn.dataset.index = String(index);
                btn.dataset.deck = deckId;
                btn.title = `${displayName}. Alt+↑/↓: порядок, Alt+←/→: в деку ${deckId === 'A' ? 'B' : 'A'}`;
                const isCurrentDeck = this.app.playingDeck ? (this.app.playingDeck === deckId) : (this.app.activeDeck === deckId);
                const isPlayingThisDeck = this.app.playingDeck === deckId;
                const isCurrentIndex = index === deck.currentTrackIndex;
                if (isCurrentDeck && isCurrentIndex) {
                    btn.classList.add('active');
                    row.classList.add('active');
                    if (isPlayingThisDeck && this.app.isPlaying && !this.app.isPaused) {
                        btn.classList.add('playing');
                        row.classList.add('playing');
                    }
                }

                const trackCols = document.createElement('div');
                trackCols.className = 'track-cols';

                const trackNum = document.createElement('span');
                trackNum.className = 'track-num';
                const trackNumText = document.createElement('span');
                trackNumText.className = 'track-num-text';
                trackNumText.textContent = String(track.trackNumber || (index + 1));
                const trackPlayHint = document.createElement('span');
                trackPlayHint.className = 'track-play-hint';
                trackPlayHint.setAttribute('aria-hidden', 'true');
                trackPlayHint.innerHTML = '<svg class="lucide lucide-play" data-lucide="play" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
                const trackPlayingIcon = document.createElement('span');
                trackPlayingIcon.className = 'track-playing-icon';
                trackPlayingIcon.setAttribute('aria-hidden', 'true');
                trackPlayingIcon.innerHTML = '<svg class="lucide lucide-volume-2" data-lucide="volume-2" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
                trackNum.append(trackNumText, trackPlayHint, trackPlayingIcon);

                const trackTitle = this.app.getTrackTitle(track);
                const trackName = document.createElement('span');
                trackName.className = 'track-name';
                trackName.textContent = trackTitle;
                trackName.title = trackTitle;
                const trackTitleCell = document.createElement('span');
                trackTitleCell.className = 'track-title-cell';
                trackTitleCell.appendChild(trackName);
                this.app.renderTrackStartBadge(trackTitleCell, track);

                const trackArtist = document.createElement('span');
                trackArtist.className = 'track-artist';
                this.app.renderTrackArtist(trackArtist, track);
                if (trackArtist.textContent) {
                    trackArtist.title = trackArtist.textContent;
                }

                const trackDuration = document.createElement('span');
                trackDuration.className = 'track-duration';
                trackDuration.textContent = track.duration
                    ? this.app.formatTime(track.duration)
                    : (track.durationUnavailable ? 'N/A' : '--:--');

                trackCols.append(trackNum, trackTitleCell, trackArtist, trackDuration);
                btn.appendChild(trackCols);

                btn.addEventListener('click', () => this.app.playTrackInDeck(deckId, index));

                const editBtn = document.createElement('button');
                editBtn.className = 'track-edit-btn';
                editBtn.type = 'button';
                editBtn.title = 'Параметры трека (метаданные, смещение)';
                editBtn.setAttribute('aria-label', `Параметры трека «${displayName}»`);
                editBtn.innerHTML = '<svg class="lucide lucide-ellipsis" data-lucide="ellipsis" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';
                editBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.app.openTrackMetadataEditor(deckId, index);
                });

                row.append(dragHandle, btn, editBtn);
                fragment.appendChild(row);

                const needsDuration = !track.duration && !track.durationUnavailable;
                const needsMetadata = !track.metadataLoaded;
                if (needsDuration || needsMetadata) {
                    pendingTrackLoads.push({ track, trackDuration, trackName, trackArtist, index, deckId, needsDuration, needsMetadata });
                }
            });

            container.appendChild(fragment);
            pendingTrackLoads.forEach(({ track, trackDuration, trackName, trackArtist, index, deckId, needsDuration, needsMetadata }) => {
                if (needsDuration) this.app.loadTrackDuration(track, trackDuration, deckId);
                if (needsMetadata) {
                    this.app.loadTrackMetadata(track, { nameElement: trackName, artistElement: trackArtist, index }, deckId);
                }
            });
        });
    }

    handleTrackDragStart(e, deckId, index) {
        this.app.dragState = {
            sourceDeckId: deckId,
            deckId,
            sourceIndex: index,
            targetDeckId: deckId,
            targetIndex: index,
            insertAfter: false
        };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${deckId}:${index}`);
        const row = e.target.closest('.track-row');
        if (row) {
            setTimeout(() => row.classList.add('dragging'), 0);
        }
    }

    handleTrackDragOver(e, deckId) {
        if (!this.app.dragState) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const row = e.target.closest('.track-row');
        if (!row) return;

        // Clear top/bottom lines on all other rows across both decks
        document.querySelectorAll('.track-row.drag-over-top, .track-row.drag-over-bottom').forEach((r) => {
            if (r !== row) r.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        document.querySelectorAll('.tracks-container.deck-drag-over').forEach((c) => {
            c.classList.remove('deck-drag-over');
        });

        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const isTop = e.clientY < midY;

        row.classList.toggle('drag-over-top', isTop);
        row.classList.toggle('drag-over-bottom', !isTop);

        this.app.dragState.targetDeckId = deckId;
        this.app.dragState.targetIndex = parseInt(row.dataset.index, 10);
        this.app.dragState.insertAfter = !isTop;
    }

    handleTrackDragEnter(e, row) {
        e.preventDefault();
    }

    handleTrackDragLeave(e, row) {
        if (!row.contains(e.relatedTarget)) {
            row.classList.remove('drag-over-top', 'drag-over-bottom');
        }
    }

    handleContainerDragOver(e, deckId) {
        if (!this.app.dragState) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        if (e.target.closest('.track-row')) return;

        // Hovering container empty area or empty state
        document.querySelectorAll('.track-row.drag-over-top, .track-row.drag-over-bottom').forEach((r) => {
            r.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        const targetContainerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
        const otherContainerId = deckId === 'A' ? 'tracksContainerB' : 'tracksContainerA';
        document.getElementById(otherContainerId)?.classList.remove('deck-drag-over');
        document.getElementById(targetContainerId)?.classList.add('deck-drag-over');

        this.app.dragState.targetDeckId = deckId;
        this.app.dragState.targetIndex = null;
        this.app.dragState.insertAfter = true;
    }

    handleContainerDragLeave(e, deckId) {
        const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
        const container = document.getElementById(containerId);
        if (container && (!e.relatedTarget || !container.contains(e.relatedTarget))) {
            container.classList.remove('deck-drag-over');
        }
    }

    handleContainerDrop(e, deckId) {
        if (!this.app.dragState) return;
        if (e.target.closest('.track-row')) return;
        e.preventDefault();
        this.app.handleTrackDrop(e, deckId, null);
    }

    handleTrackDrop(e, targetDeckId, targetIndex) {
        if (!this.app.dragState) return;
        e.preventDefault();

        const sourceDeckId = this.app.dragState.sourceDeckId || this.app.dragState.deckId;
        const sourceIndex = this.app.dragState.sourceIndex;
        const insertAfter = this.app.dragState.insertAfter;

        if (sourceDeckId === targetDeckId && targetIndex !== null && targetIndex !== undefined && sourceIndex === targetIndex) {
            this.app.handleTrackDragEnd(e);
            return;
        }

        this.app.moveTrackBetweenDecks(sourceDeckId, sourceIndex, targetDeckId, targetIndex, insertAfter);
        this.app.handleTrackDragEnd(e);
    }

    handleTrackDragEnd(e) {
        this.app.dragState = null;
        document.querySelectorAll('.track-row.dragging, .track-row.drag-over-top, .track-row.drag-over-bottom, .tracks-container.deck-drag-over').forEach((r) => {
            r.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom', 'deck-drag-over');
        });
    }

    moveTrackBetweenDecks(sourceDeckId, sourceIndex, targetDeckId, targetIndex = null, insertAfter = false) {
        const isSameDeck = sourceDeckId === targetDeckId;
        const sourceDeck = this.decks[sourceDeckId];
        const targetDeck = this.decks[targetDeckId];
        if (!sourceDeck || !targetDeck) return null;

        const movedTrack = sourceDeck.tracks?.[sourceIndex];
        if (!movedTrack) return null;

        const isPlayingThisTrack = (this.app.playingDeck === sourceDeckId &&
            this.app.currentTrackIndex === sourceIndex &&
            (this.app.isPlaying || this.app.isPaused || this.app.musicPlayerTrack === movedTrack));

        const result = this.deckManager.moveTrackBetweenDecks(sourceDeckId, sourceIndex, targetDeckId, targetIndex, insertAfter);
        if (!result) return null;

        if (isSameDeck) {
            if (sourceDeckId === (this.app.playingDeck || this.app.activeDeck)) {
                this.app.playlistTracks = result.sourceTracks;
                this.app.currentTrackIndex = result.sourceNewCurrentIndex;
            }
            this.app.displayTracks(sourceDeckId);
            this.app.highlightCurrentTrack();
            this.app.updateTrackCounter();
            this.app.updateStatus(`Дека ${sourceDeckId}: трек перемещён на позицию ${result.insertAt + 1}`);
            this.app.saveStoredData();
            this.app.pushRemoteState?.();
            return result;
        }

        // Cross-deck transfer
        if (isPlayingThisTrack) {
            this.app.playingDeck = targetDeckId;
            this.app.musicPlayerDeck = targetDeckId;
            this.app.activeDeck = targetDeckId;
            targetDeck.currentTrackIndex = result.insertAt;
            this.app.currentTrackIndex = result.insertAt;
            this.app.playlistTracks = targetDeck.tracks;
            this.app.currentPlaylist = targetDeck.playlist;
        } else {
            if (this.app.playingDeck === sourceDeckId) {
                this.app.currentTrackIndex = result.sourceNewCurrentIndex;
                this.app.playlistTracks = result.sourceTracks;
            } else if (this.app.playingDeck === targetDeckId) {
                this.app.currentTrackIndex = result.targetNewCurrentIndex;
                this.app.playlistTracks = result.targetTracks;
            } else {
                const currentDeck = this.decks[this.app.activeDeck];
                if (currentDeck) {
                    this.app.currentTrackIndex = currentDeck.currentTrackIndex;
                    this.app.playlistTracks = currentDeck.tracks;
                    this.app.currentPlaylist = currentDeck.playlist;
                }
            }
        }

        if (!this.app.isPlaying && !this.app.isPaused && !this.app.pendingMusicStart) {
            const activeDeckObj = this.decks[this.app.activeDeck];
            if (activeDeckObj && activeDeckObj.tracks && activeDeckObj.tracks.length > 0) {
                const track = activeDeckObj.tracks[activeDeckObj.currentTrackIndex || 0];
                if (track) {
                    this.app.updateCurrentTrackDisplay(track);
                    this.app.loadWaveformForTrack?.(track);
                }
            } else if (activeDeckObj && activeDeckObj.tracks.length === 0) {
                const currentTrackEl = document.getElementById('currentTrack');
                if (currentTrackEl) {
                    currentTrackEl.textContent = 'Трек не выбран';
                    currentTrackEl.title = '';
                }
                this.app.clearWaveform?.('Осциллограмма появится после выбора трека');
            }
        }

        this.app.displayTracks('A');
        this.app.displayTracks('B');
        this.app.highlightCurrentTrack();
        this.app.updateDeckUI();
        this.app.updateTrackCounter();
        const movedTitle = typeof this.app.getTrackTitle === 'function' ? this.app.getTrackTitle(movedTrack) : (movedTrack.title || movedTrack.name || 'трек');
        this.app.updateStatus(`Дека ${sourceDeckId} → Дека ${targetDeckId}: трек «${movedTitle}» перемещён (поз. ${result.insertAt + 1})`);
        this.app.saveStoredData();
        this.app.pushRemoteState?.();

        return result;
    }

    playTrackInDeck(deckId, index, options = {}) {
        const { forceDirect = false } = options;
        const deck = this.decks[deckId];
        if (!deck || !Number.isInteger(index) || !deck.tracks[index]) return;
        this.app.onlinePlayIntent = (this.app.onlinePlayIntent || 0) + 1;

        if (!forceDirect && this.app.shouldCrossfadeTo(deckId, index)) {
            this.app.startCrossfadeTo(deckId, index, options);
            return;
        }

        if (this.app.playingDeck && this.app.playingDeck !== deckId) {
            this.app.stopMusic({ silent: true });
        }

        this.app.activeDeck = deckId;
        this.app.playingDeck = deckId;

        this.app.currentPlaylist = deck.playlist;
        this.app.playlistTracks = deck.tracks;
        this.app.currentTrackIndex = index;
        deck.currentTrackIndex = index;

        this.app.loadTrack(index, { ...options, deckId });
        this.app.playMusic();
        this.app.saveStoredData();
        this.app.highlightCurrentTrack();
        this.app.updateDeckUI();
    }

    playTrack(index, options = {}) {
        const deckId = this.app.playingDeck || this.app.activeDeck;
        this.app.playTrackInDeck(deckId, index, options);
    }

    captureOnlineTarget(deckId, autoplay = false) {
        if (autoplay) this.app.onlinePlayIntent = (this.app.onlinePlayIntent || 0) + 1;
        return { deckId, tracks: this.decks[deckId]?.tracks, requestId: this.app.playlistRequestId[deckId], playIntent: this.app.onlinePlayIntent || 0 };
    }

    insertOnlineTrack(track, target, autoplay = false) {
        const deck = this.decks[target.deckId];
        if (!deck || deck.tracks !== target.tracks || this.app.playlistRequestId[target.deckId] !== target.requestId) return false;
        if (autoplay && (this.app.onlinePlayIntent || 0) !== target.playIntent) return false;
        let index = deck.tracks.findIndex(item => item.path === track.path);
        if (index < 0) { index = deck.tracks.length; deck.tracks.push(track); }
        if (!deck.playlist) deck.playlist = { name: 'Моя очередь', path: null };
        this.app.displayTracks(target.deckId);
        this.app.updateDeckUI();
        this.app.updateTrackCounter();
        this.app.saveStoredData();
        if (autoplay) {
            // Keep outgoing audio alive until the local incoming player starts, even with fades disabled.
            if (this.app.isPlaying && !this.app.isPaused && !this.app.isCrossfading && this.app.musicPlayer && this.app.musicPlayerTrack !== track) {
                this.app.startCrossfadeTo(target.deckId, index, { onlineHandoff: true });
            } else if (!this.app.isCrossfading) this.app.playTrackInDeck(target.deckId, index);
            else return false;
        }
        return true;
    }

    filterTracksInDeck(deckId, query) {
        if (!this.decks[deckId]) return;
        this.decks[deckId].filterQuery = (query || '').toLowerCase().trim();
        this.app.displayTracks(deckId);
    }

    filterTracks(query) {
        this.app.filterTracksInDeck(this.app.activeDeck, query);
    }

    setActiveDeck(deckId) {
        if (deckId !== 'A' && deckId !== 'B') return;
        this.app.activeDeck = deckId;
        if (this.app.viewMode !== 'split' && this.app.viewMode !== deckId) this.app.setViewMode(deckId);

        const deck = this.decks[deckId];
        if (!this.app.playingDeck) {
            this.app.currentPlaylist = deck.playlist;
            this.app.playlistTracks = deck.tracks;
            this.app.currentTrackIndex = deck.currentTrackIndex;
        }

        if (!this.app.isPlaying && !this.app.isPaused && !this.app.pendingMusicStart) {
            if (deck && deck.tracks && deck.tracks.length > 0) {
                const track = deck.tracks[deck.currentTrackIndex || 0];
                if (track) {
                    if (this.app.musicPlayerDeck !== deckId || this.app.musicPlayerTrack !== track) {
                        this.app.loadTrack(deck.currentTrackIndex || 0, { deckId });
                    } else {
                        this.app.updateCurrentTrackDisplay(track);
                        this.app.loadWaveformForTrack(track);
                    }
                }
            } else {
                if (this.app.musicPlayer) this.app.stopMusic({ silent: true });
                const currentTrackEl = document.getElementById('currentTrack');
                if (currentTrackEl) {
                    currentTrackEl.textContent = 'Трек не выбран';
                    currentTrackEl.title = '';
                }
                this.app.clearWaveform('Осциллограмма появится после выбора трека');
            }
        }

        this.app.updateDeckUI();
        this.app.updatePlaylistSelection();
        this.app.highlightCurrentTrack();
        this.app.updateTrackCounter();
        this.app.updateStatus(`Выбран целевой дек ${deckId}`);
        this.app.saveStoredData();
    }

    setViewMode(mode) {
        if (!['split', 'A', 'B'].includes(mode)) return;
        this.app.viewMode = mode;

        const container = document.getElementById('decksContainer');
        if (container) {
            container.classList.remove('view-a', 'view-b');
            if (mode === 'A') container.classList.add('view-a');
            if (mode === 'B') container.classList.add('view-b');
        }

        const btnSplit = document.getElementById('viewModeSplit');
        const btnA = document.getElementById('viewModeA');
        const btnB = document.getElementById('viewModeB');

        btnSplit?.classList.toggle('active', mode === 'split');
        btnA?.classList.toggle('active', mode === 'A');
        btnB?.classList.toggle('active', mode === 'B');
        [btnSplit, btnA, btnB].forEach((button) => {
            button?.setAttribute('aria-pressed', String(button.classList.contains('active')));
        });

        if (mode === 'A' || mode === 'B') {
            this.app.setActiveDeck(mode);
        }
        this.app.saveStoredData();
    }

    updateDeckUI() {
        const nameA = document.getElementById('deckNameA');
        const nameB = document.getElementById('deckNameB');
        const countA = document.getElementById('deckCountA');
        const countB = document.getElementById('deckCountB');
        const colA = document.getElementById('deckColumnA');
        const colB = document.getElementById('deckColumnB');
        const stateA = document.getElementById('deckStateA');
        const stateB = document.getElementById('deckStateB');
        const badge = document.getElementById('activeDeckBadge');

        if (nameA) {
            nameA.textContent = this.decks.A.playlist ? this.decks.A.playlist.name : 'Выберите плейлист';
        }
        if (countA) {
            const total = this.decks.A.tracks?.length || 0;
            countA.textContent = `${total} треков`;
        }

        if (nameB) {
            nameB.textContent = this.decks.B.playlist ? this.decks.B.playlist.name : 'Выберите плейлист';
        }
        if (countB) {
            const total = this.decks.B.tracks?.length || 0;
            countB.textContent = `${total} треков`;
        }

        if (colA) colA.classList.toggle('active', this.app.activeDeck === 'A');
        if (colB) colB.classList.toggle('active', this.app.activeDeck === 'B');

        const activeBadgeDeck = this.app.activeDeck;
        if (badge) {
            badge.textContent = `ДЕКА ${activeBadgeDeck}`;
            badge.classList.toggle('deck-b', activeBadgeDeck === 'B');
        }

        const isDeckPlaying = (deckId) => this.app.playingDeck === deckId && this.app.isPlaying && !this.app.isPaused;
        const isDeckPaused = (deckId) => this.app.playingDeck === deckId && this.app.isPaused;
        const hasRetiringAudio = (deckId) => Boolean(this.app.isCrossfading && this.app.retiringMusicPlayers.size > 0 && this.app.crossfadeOutgoingDeck === deckId);

        const updatePill = (element, deckId) => {
            if (!element) return;
            element.classList.remove('playing', 'paused', 'active', 'standby', 'crossfading');

            if (this.app.pendingMusicStart && this.app.musicPlayerDeck === deckId) {
                element.textContent = 'ЗАГРУЗКА';
                element.classList.add('active');
            } else if (isDeckPlaying(deckId)) {
                element.textContent = 'ИГРАЕТ ▶';
                element.classList.add('playing');
            } else if (isDeckPaused(deckId)) {
                element.textContent = 'ПАУЗА ⏸';
                element.classList.add('paused');
            } else if (hasRetiringAudio(deckId)) {
                element.textContent = 'КРОССФЕЙД ⇄';
                element.classList.add('crossfading');
            } else if (this.app.activeDeck === deckId) {
                element.textContent = 'ВЫБРАНА';
                element.classList.add('active');
            } else {
                element.textContent = 'ГОТОВА';
                element.classList.add('standby');
            }
        };

        updatePill(stateA, 'A');
        updatePill(stateB, 'B');
        ['A', 'B'].forEach((deckId) => {
            document.getElementById(`deckHeader${deckId}`)?.setAttribute('aria-pressed', String(this.app.activeDeck === deckId));
        });

        this.app.updatePlaylistSelection();
        this.app.broadcastRemoteState();
    }

    highlightCurrentTrack() {
        ['A', 'B'].forEach((deckId) => {
            const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
            const container = document.getElementById(containerId);
            if (!container) return;

            const isPlayingThisDeck = this.app.playingDeck === deckId;
            const currentIndex = this.decks[deckId].currentTrackIndex;

            container.querySelectorAll('.track-row').forEach((row) => {
                const rowIdx = Number(row.dataset.index);
                const btn = row.querySelector('.track-btn');
                const isCurrentDeck = this.app.playingDeck ? isPlayingThisDeck : (this.app.activeDeck === deckId);
                const isActive = isCurrentDeck && rowIdx === currentIndex;
                const isPlaying = isPlayingThisDeck && rowIdx === currentIndex && this.app.isPlaying && !this.app.isPaused;

                row.classList.toggle('active', isActive);
                btn?.classList.toggle('active', isActive);
                row.classList.toggle('playing', isPlaying);
                btn?.classList.toggle('playing', isPlaying);

                if (isActive && isPlayingThisDeck) {
                    (row || btn).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            });
        });
        this.app.updateTrackCounter();
        this.app.updateDeckUI();
    }

    updateTrackCounter() {
        const counterEl = document.getElementById('trackCounter');
        if (!counterEl) return;
        const deckId = this.app.playingDeck || this.app.activeDeck;
        const deck = this.decks[deckId];
        const tracks = deck?.tracks || [];
        if (tracks.length > 0) {
            const current = (deck.currentTrackIndex || 0) + 1;
            const total = tracks.length;
            counterEl.textContent = `${current} / ${total}`;
        } else {
            counterEl.textContent = '— / —';
        }
    }
}

    return { CASDecksController };
});
