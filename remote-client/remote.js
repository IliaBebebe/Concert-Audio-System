/* CAS phone client. Browsing and cueing are local; only explicit actions send commands. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const app = document.querySelector('.remote-app');
  const deckButtons = [...document.querySelectorAll('[data-deck]')];
  const navButtons = [...document.querySelectorAll('[data-screen]')];
  const commandButtons = [...document.querySelectorAll('[data-command]')];
  let token = new URLSearchParams(location.search).get('token') || new URLSearchParams(location.search).get('t') || '';
  try { token ||= sessionStorage.getItem('cas-remote-token') || ''; } catch {}
  let state = null;
  let selectedDeck = 'A';
  let screen = 'screenTransport';
  let cue = null;
  let stream = null;
  let generation = 0;
  let ready = false;
  let connecting = false;
  let retryTimer = null;
  let healthTimer = null;
  let retryDelay = 1000;
  let cooldownUntil = 0;
  let trackSignature = '';
  let trackRows = [];
  const padRows = [];
  const pending = new Set();
  let volumeTimer = null;
  let queuedVolume = null;
  let volumeSending = false;

  const tracksFor = deck => state?.[deck === 'A' ? 'deckA' : 'deckB']?.tracks || [];
  const deckSignature = deck => JSON.stringify([state?.[deck === 'A' ? 'deckA' : 'deckB']?.name,
    tracksFor(deck).map(t => [t.index, t.name, t.durationStr])]);
  const isPlaying = () => Boolean(state?.isPlaying && !state?.isPaused);
  const time = value => {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  function error(message = '') {
    $('commandError').textContent = message;
    $('commandError').hidden = !message;
  }

  function connection(online, label, message = '') {
    ready = online;
    $('connectionStatus').dataset.online = String(online);
    $('statusText').textContent = label;
    $('connectionNotice').textContent = message;
    $('connectionNotice').hidden = !message;
    renderControls();
  }

  function pairing(show, message = '') {
    const wasOpen = !$('pairing').hidden;
    $('pairing').hidden = !show;
    app.inert = show;
    $('pinError').textContent = message;
    $('pinError').hidden = !message;
    if (show) $('pinInput').focus();
    else if (wasOpen) $('main').focus();
  }

  async function request(endpoint, options = {}) {
    const response = await fetch(`/api/${endpoint}?token=${encodeURIComponent(token)}`, {
      ...options, signal: AbortSignal.timeout(6000), cache: 'no-store'
    });
    if (!response.ok) {
      const failure = new Error(`HTTP ${response.status}`);
      failure.status = response.status;
      failure.retryAfter = Number(response.headers.get('Retry-After')) || 60;
      throw failure;
    }
    return response.json();
  }

  function closeStream() {
    stream?.close();
    stream = null;
    clearTimeout(retryTimer);
    retryTimer = null;
    clearInterval(healthTimer);
  }

  function forgetAccess(message) {
    generation++;
    closeStream();
    token = '';
    try { sessionStorage.removeItem('cas-remote-token'); } catch {}
    // An expired QR credential must not be picked up again on reload.
    const url = new URL(location.href);
    url.searchParams.delete('token');
    url.searchParams.delete('t');
    history.replaceState(null, '', url);
    cue = null;
    renderCue();
    connection(false, 'Нужен PIN');
    pairing(true, message);
  }

  function disconnected() {
    closeStream();
    queuedVolume = null;
    clearTimeout(volumeTimer);
    cue = null;
    renderCue();
    connection(false, 'Нет связи', 'Связь с CAS потеряна. Проверьте сеть Wi-Fi. Подключение восстановится автоматически.');
    if (token && document.visibilityState !== 'hidden') {
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10000);
    }
  }

  async function connect() {
    if (Date.now() < cooldownUntil || document.visibilityState === 'hidden') return;
    closeStream();
    const attempt = ++generation;
    if (!token) {
      connection(false, 'Нужен PIN');
      pairing(true);
      return;
    }
    connecting = true;
    $('btnConnect').disabled = true;
    $('btnConnect').textContent = 'Подключаемся…';
    connection(false, 'Подключение', 'Получаем состояние CAS…');
    try {
      // Validate once before SSE: invalid PINs never enter an automatic retry loop.
      const snapshot = await request('status');
      if (attempt !== generation) return;
      if (snapshot.state) receiveState(snapshot.state);
      else state = null;
      const source = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
      stream = source;
      source.onopen = () => {
        if (attempt !== generation) return;
        retryDelay = 1000;
        try { sessionStorage.setItem('cas-remote-token', token); } catch {}
        pairing(false);
        connection(Boolean(state), state ? 'На связи' : 'Ожидание CAS', state ? '' : 'CAS ещё готовит рабочее пространство…');
        // Detect silent network loss, including Wi-Fi changes while SSE is idle.
        healthTimer = setInterval(async () => {
          try {
            const current = await request('status');
            if (attempt !== generation) return;
            if (current.state) {
              receiveState(current.state);
              connection(true, 'На связи');
            }
          } catch {
            if (attempt !== generation) return;
            generation++;
            disconnected();
          }
        }, 10000);
      };
      source.addEventListener('state', event => {
        if (attempt !== generation) return;
        try {
          receiveState(JSON.parse(event.data));
          connection(true, 'На связи');
        } catch {
          error('Не удалось прочитать состояние CAS. Переподключитесь нажатием на статус связи.');
          connection(false, 'Ошибка данных');
        }
      });
      source.onerror = () => {
        if (attempt !== generation) return;
        generation++;
        disconnected();
      };
    } catch (failure) {
      if (attempt !== generation) return;
      if (failure.status === 401) {
        forgetAccess('PIN не принят или срок доступа истёк. Введите PIN из CAS.');
      } else if (failure.status === 429) {
        cooldownUntil = Date.now() + failure.retryAfter * 1000;
        forgetAccess(`Слишком много попыток. Повторите через ${failure.retryAfter} сек.`);
      } else {
        disconnected();
        if (!$('pairing').hidden) pairing(true, 'CAS недоступен. Проверьте адрес, сеть и тумблер в настройках CAS.');
      }
    } finally {
      if (attempt === generation || !token) {
        connecting = false;
        $('btnConnect').disabled = false;
        $('btnConnect').textContent = 'Подключиться';
      }
    }
  }

  async function command(action, params = {}) {
    const key = action === 'triggerPad' ? `${action}:${params.index}` : action;
    if (!ready || pending.has(key)) return false;
    const attempt = generation;
    pending.add(key);
    error();
    renderControls();
    try {
      const result = await request('command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...params })
      });
      if (attempt !== generation) return false;
      if (!result.success) throw new Error('Command rejected');
      return true;
    } catch (failure) {
      if (attempt !== generation) return false;
      if (failure.status === 401) forgetAccess('Доступ изменился. Введите текущий PIN из CAS.');
      else {
        error('Не удалось подтвердить команду. Проверьте состояние CAS перед повторным нажатием.');
        generation++;
        disconnected();
      }
      // Commands are never replayed after reconnect: a pad or next-track action is not idempotent.
      return false;
    } finally {
      pending.delete(key);
      renderControls();
    }
  }

  function renderControls() {
    commandButtons.forEach(button => { button.disabled = !ready; });
    trackRows.forEach(({ row }) => { row.disabled = !ready; });
    const hasTrack = Boolean(state?.currentTrack);
    const deck = state?.playingDeck || state?.activeDeck || 'A';
    $('btnPlayPause').disabled = !ready || !hasTrack || pending.has('play') || pending.has('pause');
    $('btnStop').disabled = !ready || !hasTrack || pending.has('stop');
    $('btnPrev').disabled = !ready || !tracksFor(deck).length || pending.has('prev');
    $('btnNext').disabled = !ready || !tracksFor(deck).length || pending.has('next');
    $('btnMute').disabled = !ready || pending.has('panicMute');
    $('btnLaunch').disabled = !ready || !cue || pending.has('selectTrack');
    $('btnLaunch').textContent = pending.has('selectTrack') ? 'Запуск…' : 'Запустить';
    $('btnStopPads').disabled = !ready || pending.has('stopPads') || !state?.pads?.some(p => p.isPlaying);
    padRows.forEach((row, i) => { row.disabled = !ready || !state?.pads?.[i]?.isAssigned || pending.has(`triggerPad:${i}`); });
  }

  function receiveState(next) {
    if (!next || typeof next !== 'object' || !next.deckA || !next.deckB || !Array.isArray(next.pads)) throw new Error('Invalid state');
    state = next;
    if (cue && cue.signature !== deckSignature(cue.deck)) {
      cue = null;
      error('Список треков изменился на компьютере. Выберите трек заново.');
    }
    const track = state.currentTrack;
    const playing = isPlaying();
    $('playingDeck').textContent = `Дека ${track?.deck || state.playingDeck || state.activeDeck || 'A'}`;
    $('playbackStatus').textContent = playing ? 'Воспроизводится' : state.isPaused ? 'На паузе' : 'Ожидание';
    $('nowPlayingTitle').textContent = track?.title || 'Трек не выбран';
    $('nowPlayingArtist').textContent = track?.artist || track?.playlistName || 'Откройте треки и подготовьте запуск';
    $('trackPosition').textContent = state.isMuted ? 'Звук выключен' : '';
    const duration = Math.max(0, Number(track?.duration) || 0);
    const current = Math.max(0, Number(track?.currentTime) || 0);
    const remaining = Math.max(0, Number(track?.remainingTime ?? (duration - current)) || 0);
    const progress = duration ? Math.min(1, current / duration) : 0;
    $('currentTime').textContent = time(current);
    $('totalTime').textContent = time(duration);
    $('remainingTime').textContent = time(remaining);
    $('trackProgressFill').style.transform = `scaleX(${progress})`;
    $('trackProgress').setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    $('trackProgress').setAttribute('aria-valuetext', `${time(current)} из ${time(duration)}`);
    $('playbackPanel').dataset.ending = playing && duration > 15 && remaining <= 15 ? (remaining <= 5 ? 'critical' : 'warning') : '';
    $('playIcon').toggleAttribute('hidden', playing);
    $('pauseIcon').toggleAttribute('hidden', !playing);
    $('playLabel').textContent = playing ? 'Пауза' : state.isPaused ? 'Продолжить' : 'Воспроизвести';
    $('btnMute').setAttribute('aria-pressed', String(Boolean(state.isMuted)));
    $('muteLabel').textContent = state.isMuted ? 'Включить весь звук' : 'Выключить весь звук';
    if (!volumeSending && queuedVolume === null) {
      const percent = Math.round(Math.max(0, Math.min(1, Number(state.masterVolume) || 0)) * 100);
      $('volumeSlider').value = percent;
      $('volumeValue').textContent = `${percent}%`;
    }
    ['A', 'B'].forEach(deck => { $(`deckName${deck}`).textContent = state[deck === 'A' ? 'deckA' : 'deckB'].name || `Дека ${deck}`; });
    renderPads();
    renderCue();
    renderControls();
  }

  function empty(title, hint) {
    const element = document.createElement('div');
    element.className = 'empty-state';
    const heading = document.createElement('strong');
    heading.textContent = title;
    element.append(heading, document.createTextNode(hint));
    return element;
  }

  function renderTracks() {
    const tracks = tracksFor(selectedDeck);
    const query = $('trackSearch').value.trim().toLocaleLowerCase('ru');
    const filtered = tracks.filter(track => !query || String(track.name || '').toLocaleLowerCase('ru').includes(query));
    $('trackCount').textContent = query ? `${filtered.length} / ${tracks.length}` : `${tracks.length} в списке`;
    // Rebuild only when the list/filter changes. Playback ticks preserve focus, scroll and touch targets.
    const signature = JSON.stringify([selectedDeck, query, tracks.map(t => [t.index, t.name, t.durationStr])]);
    if (signature !== trackSignature) {
      trackSignature = signature;
      trackRows = filtered.map(track => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'track-row';
        row.dataset.index = track.index;
        const number = document.createElement('span');
        number.className = 'track-number';
        number.textContent = String(track.index + 1).padStart(2, '0');
        const copy = document.createElement('span');
        copy.className = 'track-copy';
        const name = document.createElement('span');
        name.className = 'track-name';
        name.textContent = track.name || 'Без названия';
        const meta = document.createElement('span');
        meta.className = 'track-meta';
        const check = document.createElement('span');
        check.className = 'track-check';
        check.setAttribute('aria-hidden', 'true');
        copy.append(name, meta);
        row.append(number, copy, check);
        return { row, track, meta, check };
      });
      $('tracklist').replaceChildren(...(trackRows.length ? trackRows.map(item => item.row) : [empty(
        tracks.length ? 'Ничего не найдено' : 'Дека пока пуста',
        tracks.length ? 'Измените запрос или очистите поиск.' : 'Загрузите плейлист в эту деку на компьютере.'
      )]));
    }
    const currentTracks = new Map(tracks.map(track => [track.index, track]));
    trackRows.forEach(({ row, track, meta, check }) => {
      const playing = Boolean(currentTracks.get(track.index)?.isPlaying);
      const selected = cue?.deck === selectedDeck && cue.index === track.index;
      row.classList.toggle('is-playing', playing);
      row.setAttribute('aria-pressed', String(Boolean(selected)));
      meta.textContent = `${track.durationStr || 'Длительность неизвестна'}${playing ? ' · В эфире' : selected ? ' · К запуску' : ''}`;
      check.textContent = selected ? '✓' : '';
      row.disabled = !ready;
    });
  }

  function renderPads() {
    if (!padRows.length) {
      for (let i = 0; i < 12; i++) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'pad-cell';
        row.dataset.pad = i;
        const number = document.createElement('span');
        number.className = 'pad-number';
        const name = document.createElement('span');
        name.className = 'pad-name';
        row.append(number, name);
        padRows.push(row);
      }
      $('padsGrid').replaceChildren(...padRows);
    }
    let count = 0;
    padRows.forEach((row, i) => {
      const pad = state?.pads?.[i];
      const assigned = Boolean(pad?.isAssigned);
      if (assigned) count++;
      row.classList.toggle('is-playing', Boolean(pad?.isPlaying));
      row.children[0].textContent = `${String(i + 1).padStart(2, '0')}${pad?.isPlaying ? ' · Звучит' : ''}`;
      row.children[1].textContent = assigned ? pad.name || `Пэд ${i + 1}` : 'Не назначен';
      row.setAttribute('aria-label', `Пэд ${i + 1}: ${assigned ? pad.name || 'Звук' : 'Не назначен'}${pad?.isPlaying ? ', звучит' : ''}`);
    });
    $('padCount').textContent = `${count} из 12`;
    $('padsHint').hidden = count > 0;
  }

  function renderCue() {
    $('cueBar').hidden = !cue;
    if (cue) {
      $('cueDeck').textContent = `К запуску · Дека ${cue.deck}`;
      $('cueTitle').textContent = cue.name;
    }
    renderTracks();
    renderControls();
  }

  function navigate(target) {
    screen = target;
    document.querySelectorAll('.screen').forEach(section => { section.hidden = section.id !== target; });
    navButtons.forEach(button => {
      if (button.dataset.screen === target) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('main').scrollTop = 0;
  }

  async function flushVolume() {
    clearTimeout(volumeTimer);
    if (volumeSending || queuedVolume === null || !ready) return;
    volumeSending = true;
    const value = queuedVolume;
    queuedVolume = null;
    await command('setVolume', { volume: value / 100 });
    volumeSending = false;
    if (queuedVolume !== null && ready) flushVolume();
  }

  $('volumeSlider').addEventListener('input', () => {
    if (!ready) return;
    queuedVolume = Number($('volumeSlider').value);
    $('volumeValue').textContent = `${queuedVolume}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(flushVolume, 100);
  });
  $('volumeSlider').addEventListener('change', flushVolume);
  $('btnPlayPause').addEventListener('click', () => command(isPlaying() ? 'pause' : 'play'));
  $('btnPrev').addEventListener('click', () => command('prev'));
  $('btnNext').addEventListener('click', () => command('next'));
  $('btnStop').addEventListener('click', () => command('stop'));
  $('btnMute').addEventListener('click', () => command('panicMute'));
  $('btnStopPads').addEventListener('click', () => command('stopPads'));
  $('browseTracks').addEventListener('click', () => navigate('screenTracks'));
  navButtons.forEach(button => button.addEventListener('click', () => navigate(button.dataset.screen)));
  deckButtons.forEach(button => button.addEventListener('click', () => {
    selectedDeck = button.dataset.deck;
    deckButtons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    $('trackSearch').value = '';
    renderTracks();
  }));
  $('trackSearch').addEventListener('input', renderTracks);
  $('tracklist').addEventListener('click', event => {
    if (!ready) return;
    const row = event.target.closest('[data-index]');
    if (!row) return;
    const track = tracksFor(selectedDeck).find(item => item.index === Number(row.dataset.index));
    if (!track) return;
    cue = { deck: selectedDeck, index: track.index, name: track.name, signature: deckSignature(selectedDeck) };
    error();
    renderCue();
  });
  $('btnClearCue').addEventListener('click', () => { cue = null; renderCue(); });
  $('btnLaunch').addEventListener('click', async () => {
    if (!cue) return;
    const launch = cue;
    if (launch.signature !== deckSignature(launch.deck)) return;
    if (await command('selectTrack', { deck: launch.deck, index: launch.index, autoplay: true })) {
      if (cue === launch) cue = null;
      renderCue();
      navigate('screenTransport');
    }
  });
  $('padsGrid').addEventListener('click', event => {
    const row = event.target.closest('[data-pad]');
    if (row && !row.disabled) command('triggerPad', { index: Number(row.dataset.pad) });
  });
  $('pinForm').addEventListener('submit', event => {
    event.preventDefault();
    if (connecting) return;
    if (Date.now() < cooldownUntil) {
      pairing(true, `Повторите через ${Math.ceil((cooldownUntil - Date.now()) / 1000)} сек.`);
      return;
    }
    const value = $('pinInput').value.trim();
    if (!/^\d{4}$/.test(value)) { pairing(true, 'Введите четыре цифры PIN из CAS.'); return; }
    token = value;
    connect();
  });
  $('connectionStatus').addEventListener('click', connect);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') connect();
    else {
      generation++;
      closeStream();
      queuedVolume = null;
      clearTimeout(volumeTimer);
      connection(false, 'Подключение');
    }
  });
  window.addEventListener('pagehide', () => { generation++; closeStream(); });
  window.addEventListener('pageshow', event => { if (event.persisted) connect(); });
  window.addEventListener('online', connect);
  window.addEventListener('offline', () => { generation++; disconnected(); });

  renderPads();
  renderControls();
  navigate(screen);
  connect();
})();
