/**
 * CAS Remote Web Client
 * Connects via SSE and sends commands via HTTP POST.
 */

(function () {
    'use strict';

    // State
    let token = new URLSearchParams(window.location.search).get('token') || '';
    let eventSource = null;
    let latestState = null;
    let selectedDeck = 'A';
    let isConnected = false;

    // DOM Elements
    const connectionStatus = document.getElementById('connectionStatus');
    const statusText = connectionStatus.querySelector('.status-text');
    const btnDeckA = document.getElementById('btnDeckA');
    const btnDeckB = document.getElementById('btnDeckB');

    // Transport Elements
    const nowPlayingDeckBadge = document.getElementById('nowPlayingDeckBadge');
    const nowPlayingTitle = document.getElementById('nowPlayingTitle');
    const nowPlayingArtist = document.getElementById('nowPlayingArtist');
    const trackProgressFill = document.getElementById('trackProgressFill');
    const currentTimeDisplay = document.getElementById('currentTimeDisplay');
    const remainingTimeBadge = document.getElementById('remainingTimeBadge');
    const totalTimeDisplay = document.getElementById('totalTimeDisplay');
    const btnPlayPause = document.getElementById('btnPlayPause');
    const iconPlay = document.getElementById('iconPlay');
    const iconPause = document.getElementById('iconPause');
    const btnPrev = document.getElementById('btnPrev');
    const btnNext = document.getElementById('btnNext');
    const btnStop = document.getElementById('btnStop');
    const btnMute = document.getElementById('btnMute');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeValue = document.getElementById('volumeValue');

    // Tracklist Elements
    const trackSearchInput = document.getElementById('trackSearchInput');
    const tracklistContainer = document.getElementById('tracklistContainer');

    // Pads Elements
    const padsGrid = document.getElementById('padsGrid');
    const btnStopPads = document.getElementById('btnStopPads');

    // Navigation & PIN
    const tabButtons = document.querySelectorAll('.tab-item');
    const screens = document.querySelectorAll('.remote-screen');
    const pinOverlay = document.getElementById('pinOverlay');
    const pinInput = document.getElementById('pinInput');
    const btnPinSubmit = document.getElementById('btnPinSubmit');
    const pinError = document.getElementById('pinError');

    // Haptic feedback helper
    function vibrate(ms = 15) {
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
            try { navigator.vibrate(ms); } catch {}
        }
    }

    // Format seconds to mm:ss
    function formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    // Send command to CAS desktop
    async function sendCommand(action, params = {}) {
        vibrate();
        try {
            const res = await fetch(`/api/command?token=${encodeURIComponent(token)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, ...params })
            });
            if (res.status === 401) {
                showPinPrompt();
            }
            return await res.json();
        } catch (err) {
            console.error('Command failed:', err);
        }
    }

    // Connect to SSE stream
    function connectStream() {
        if (!token) {
            showPinPrompt();
            return;
        }

        if (eventSource) {
            eventSource.close();
        }

        updateStatus(false, 'Подключение...');

        eventSource = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

        eventSource.onopen = () => {
            isConnected = true;
            updateStatus(true, 'Онлайн');
            hidePinPrompt();
        };

        eventSource.addEventListener('state', (event) => {
            try {
                const state = JSON.parse(event.data);
                latestState = state;
                renderState(state);
            } catch (err) {
                console.error('Failed to parse state:', err);
            }
        });

        eventSource.onerror = () => {
            isConnected = false;
            updateStatus(false, 'Связь потеряна');
            // Reconnect is handled automatically by EventSource, but if 401:
            fetch(`/api/status?token=${encodeURIComponent(token)}`).then(res => {
                if (res.status === 401) {
                    showPinPrompt();
                }
            }).catch(() => {});
        };
    }

    function updateStatus(online, text) {
        connectionStatus.className = 'header-status ' + (online ? 'online' : 'offline');
        statusText.textContent = text;
    }

    // Render incoming state
    function renderState(state) {
        if (!state) return;

        // Active Deck sync
        if (state.activeDeck && state.activeDeck !== selectedDeck) {
            selectedDeck = state.activeDeck;
            updateDeckButtons();
        }

        // Current track
        const track = state.currentTrack;
        if (track && track.title) {
            nowPlayingTitle.textContent = track.title;
            nowPlayingArtist.textContent = track.artist || track.playlistName || 'Плейлист CAS';
            nowPlayingDeckBadge.textContent = `ДЕКА ${track.deck || selectedDeck}`;

            const cur = track.currentTime || 0;
            const dur = track.duration || 0;
            const rem = track.remainingTime !== undefined ? track.remainingTime : Math.max(0, dur - cur);

            currentTimeDisplay.textContent = formatTime(cur);
            totalTimeDisplay.textContent = formatTime(dur);
            remainingTimeBadge.textContent = `-${formatTime(rem)}`;

            const pct = dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;
            trackProgressFill.style.width = `${pct}%`;

            // Stage Ending Alerts
            remainingTimeBadge.classList.remove('stage-ending-warning', 'stage-ending-critical');
            if (state.isPlaying && !state.isPaused && dur > 15) {
                if (rem <= 5) {
                    remainingTimeBadge.classList.add('stage-ending-critical');
                } else if (rem <= 15) {
                    remainingTimeBadge.classList.add('stage-ending-warning');
                }
            }
        } else {
            nowPlayingTitle.textContent = 'Трек не выбран';
            nowPlayingArtist.textContent = `Дека ${selectedDeck} готова к загрузке`;
            nowPlayingDeckBadge.textContent = `ДЕКА ${selectedDeck}`;
            currentTimeDisplay.textContent = '0:00';
            totalTimeDisplay.textContent = '0:00';
            remainingTimeBadge.textContent = '-0:00';
            trackProgressFill.style.width = '0%';
            remainingTimeBadge.classList.remove('stage-ending-warning', 'stage-ending-critical');
        }

        // Play/Pause button
        const isPlaying = Boolean(state.isPlaying && !state.isPaused);
        if (isPlaying) {
            btnPlayPause.classList.add('is-playing');
            iconPlay.toggleAttribute('hidden', true);
            iconPause.toggleAttribute('hidden', false);
        } else {
            btnPlayPause.classList.remove('is-playing');
            iconPlay.toggleAttribute('hidden', false);
            iconPause.toggleAttribute('hidden', true);
        }

        // Mute button
        if (state.isMuted) {
            btnMute.classList.add('is-muted');
        } else {
            btnMute.classList.remove('is-muted');
        }

        // Volume
        if (typeof state.masterVolume === 'number') {
            const volPct = Math.round(state.masterVolume * 100);
            if (document.activeElement !== volumeSlider) {
                volumeSlider.value = volPct;
            }
            volumeValue.textContent = `${volPct}%`;
        }

        // Render Tracklist for selected deck
        renderTracklist(state);

        // Render Pads
        renderPads(state.pads);
    }

    function updateDeckButtons() {
        btnDeckA.classList.toggle('is-active', selectedDeck === 'A');
        btnDeckB.classList.toggle('is-active', selectedDeck === 'B');
        if (latestState) renderTracklist(latestState);
    }

    function renderTracklist(state) {
        const deckData = selectedDeck === 'A' ? state.deckA : state.deckB;
        if (!deckData || !Array.isArray(deckData.tracks) || deckData.tracks.length === 0) {
            tracklistContainer.innerHTML = '<div class="tracklist-empty">В этой деке нет загруженных треков</div>';
            return;
        }

        const filter = (trackSearchInput.value || '').trim().toLowerCase();
        const filtered = deckData.tracks.filter(t => !filter || (t.name || '').toLowerCase().includes(filter));

        if (filtered.length === 0) {
            tracklistContainer.innerHTML = '<div class="tracklist-empty">Треки не найдены</div>';
            return;
        }

        let html = '';
        for (const t of filtered) {
            const isPlaying = Boolean(t.isPlaying);
            html += `
                <div class="track-item ${isPlaying ? 'is-playing' : ''}" data-index="${t.index}">
                    <div class="track-item-left">
                        <span class="track-item-num">${t.index + 1}</span>
                        <span class="track-item-name">${escapeHtml(t.name)}</span>
                    </div>
                    <span class="track-item-time">${t.durationStr || '--:--'}</span>
                </div>
            `;
        }
        tracklistContainer.innerHTML = html;
    }

    function renderPads(pads) {
        if (!Array.isArray(pads) || pads.length === 0) return;
        let html = '';
        for (let i = 0; i < 12; i++) {
            const pad = pads[i] || { index: i, name: '', isPlaying: false };
            const isPlaying = Boolean(pad.isPlaying);
            html += `
                <button type="button" class="pad-cell ${isPlaying ? 'is-playing' : ''}" data-pad="${i}">
                    <span class="pad-number">${i + 1}</span>
                    <span class="pad-name">${escapeHtml(pad.name || `Пэд ${i + 1}`)}</span>
                </button>
            `;
        }
        padsGrid.innerHTML = html;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // PIN prompt
    function showPinPrompt() {
        pinOverlay.hidden = false;
        pinError.hidden = true;
        pinInput.value = '';
        pinInput.focus();
    }

    function hidePinPrompt() {
        pinOverlay.hidden = true;
    }

    // Bind Event Listeners
    btnPlayPause.addEventListener('click', () => {
        const isPlaying = Boolean(latestState?.isPlaying && !latestState?.isPaused);
        sendCommand(isPlaying ? 'pause' : 'play');
    });

    btnPrev.addEventListener('click', () => sendCommand('prev'));
    btnNext.addEventListener('click', () => sendCommand('next'));
    btnStop.addEventListener('click', () => sendCommand('stop'));
    btnMute.addEventListener('click', () => sendCommand('panicMute'));

    volumeSlider.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        volumeValue.textContent = `${val}%`;
        sendCommand('setVolume', { volume: val / 100 });
    });

    btnDeckA.addEventListener('click', () => {
        selectedDeck = 'A';
        updateDeckButtons();
        sendCommand('selectDeck', { deck: 'A' });
    });

    btnDeckB.addEventListener('click', () => {
        selectedDeck = 'B';
        updateDeckButtons();
        sendCommand('selectDeck', { deck: 'B' });
    });

    trackSearchInput.addEventListener('input', () => {
        if (latestState) renderTracklist(latestState);
    });

    tracklistContainer.addEventListener('click', (e) => {
        const item = e.target.closest('.track-item');
        if (!item) return;
        const index = Number(item.dataset.index);
        if (Number.isFinite(index)) {
            sendCommand('selectTrack', { index, deck: selectedDeck, autoplay: true });
        }
    });

    padsGrid.addEventListener('click', (e) => {
        const cell = e.target.closest('.pad-cell');
        if (!cell) return;
        const index = Number(cell.dataset.pad);
        if (Number.isFinite(index)) {
            sendCommand('triggerPad', { index });
        }
    });

    btnStopPads.addEventListener('click', () => sendCommand('stopPads'));

    // Tab Navigation
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            vibrate(10);
            const targetId = btn.dataset.tab;
            tabButtons.forEach(b => b.classList.remove('is-active'));
            screens.forEach(s => s.classList.remove('is-active'));

            btn.classList.add('is-active');
            const targetScreen = document.getElementById(targetId);
            if (targetScreen) targetScreen.classList.add('is-active');
        });
    });

    // PIN Submit
    btnPinSubmit.addEventListener('click', () => {
        const entered = pinInput.value.trim();
        if (entered.length >= 4) {
            token = entered;
            connectStream();
        } else {
            pinError.hidden = false;
            pinError.textContent = 'Введите 4 цифры PIN-кода';
        }
    });

    pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnPinSubmit.click();
    });

    // Handle Mobile Visibility / Wakeup
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !isConnected) {
            connectStream();
        }
    });

    // Initial connection
    connectStream();
})();
