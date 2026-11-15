/* Network access stays in main; the panel receives metadata and managed local files. */
const ONLINE_SOURCE_NAMES = { soundcloud: 'SoundCloud', yandex: 'Яндекс Музыка', youtube: 'YouTube' };

class CASOnlinePanel {
  constructor(mixer) {
    this.mixer = mixer;
    this.api = window.electronAPI;
    this.panel = document.getElementById('onlineMusicPanel');
    this.results = document.getElementById('onlineResults');
    this.status = document.getElementById('onlineStatus');
    this.jobs = new Map();
    this.rows = new Map();
    this.failures = new Map();
    this.searchGeneration = 0;
    this.source = 'all';
    this.view = 'search';
    this.searchTracks = [];
    this.searchWarnings = [];
    this.searchBusy = false;
    try {
      const saved = JSON.parse(localStorage.getItem('casOnlinePanel') || '{}');
      if (saved.source === 'all' || Object.hasOwn(ONLINE_SOURCE_NAMES, saved.source)) this.source = saved.source;
      if (['A', 'B'].includes(saved.deck)) document.getElementById('onlineTargetDeck').value = saved.deck;
      this.panel.open = saved.open === true;
    } catch { /* An unavailable preference store must not disable online music. */ }
    this.selectSource(this.source);
    this.panel.addEventListener('toggle', () => {
      document.getElementById('openOnlineSearch')?.setAttribute('aria-expanded', String(this.panel.open));
      this.savePreferences();
    });
    document.getElementById('onlineTargetDeck').addEventListener('change', () => this.savePreferences());
    document.getElementById('onlineSearchForm').addEventListener('submit', event => {
      event.preventDefault();
      if (this.searchBusy) this.cancelSearch(); else this.search();
    });
    document.getElementById('onlineSearchButton').addEventListener('click', event => {
      if (this.searchBusy) { event.preventDefault(); this.cancelSearch(); }
    });
    document.querySelectorAll('[data-online-source]').forEach(button => button.addEventListener('click', () => {
      this.selectSource(button.dataset.onlineSource);
      if (document.getElementById('onlineQuery').value.trim()) this.search();
    }));
    document.getElementById('onlineBrowseButton').addEventListener('click', () => this.showSearch());
    document.getElementById('onlineSavedButton').addEventListener('click', () => this.showLibrary());
    document.getElementById('onlineAccountsButton')?.addEventListener('click', () => this.openAccounts());
    for (const source of ['yandex', 'youtube', 'soundcloud']) {
      for (const action of ['connect', 'disconnect', 'open']) {
        document.getElementById(`account-${source}-${action}`)?.addEventListener('click', () => this.accountAction(source, action));
      }
    }
    for (const topic of ['guide', 'chrome', 'firefox']) {
      document.getElementById(`account-help-${topic}`)?.addEventListener('click', async () => {
        try {
          const result = await this.api.openOnlineAccountsHelp(topic);
          if (!result.success) this.accountStatus(result.error, true);
        } catch { this.accountStatus('Не удалось открыть справку. Проверьте браузер.', true); }
      });
    }
    document.getElementById('onlineFolderButton').addEventListener('click', async () => {
      try {
        const result = await this.api.openOnlineLibrary();
        if (!result.success) this.setStatus(result.error, true);
      } catch { this.setStatus('Не удалось открыть папку сохранённых треков.', true); }
    });
    this.api.onOnlineProgress(progress => this.updateProgress(progress));
    this.render([]);
  }

  accountStatus(message, error = false) {
    const status = document.getElementById('onlineAccountsStatus');
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  async refreshAccounts() {
    const result = await this.api.getOnlineAccountsStatus();
    if (!result.success) throw new Error(result.error);
    for (const source of ['yandex', 'youtube', 'soundcloud']) {
      const saved = result.data[source] === true;
      document.getElementById(`account-${source}-state`).textContent = saved ? 'Данные входа сохранены' : 'Пока не подключён';
      document.getElementById(`account-${source}-disconnect`).hidden = !saved;
      document.getElementById(`account-${source}-connect`).textContent = source === 'yandex'
        ? saved ? 'Войти заново' : 'Войти в Яндекс'
        : saved ? 'Заменить файл' : 'Выбрать cookies.txt';
      const button = document.getElementById(`account-${source}-connect`);
      button.setAttribute('aria-label', `${button.textContent}: ${ONLINE_SOURCE_NAMES[source]}`);
    }
  }

  async openAccounts() {
    const dialog = document.getElementById('onlineAccountsDialog');
    if (!dialog.open) dialog.showModal();
    if (this.accountsBusy) return;
    this.accountStatus('Подключите нужный сервис один раз. Затем повторите подготовку трека.');
    try { await this.refreshAccounts(); }
    catch (error) { this.accountStatus(error.message, true); }
  }

  async accountAction(source, action) {
    if (this.accountsBusy) return;
    this.accountsBusy = true;
    for (const service of ['yandex', 'youtube', 'soundcloud']) {
      for (const name of ['connect', 'disconnect', 'open']) document.getElementById(`account-${service}-${name}`).setAttribute('aria-disabled', 'true');
    }
    try {
      const result = await this.api.manageOnlineAccounts({ source, action });
      if (!result.success) throw new Error(result.error);
      this.accountStatus(result.data);
      this.setStatus(result.data);
      await this.refreshAccounts();
    } catch (error) { this.accountStatus(error.message, true); }
    finally {
      this.accountsBusy = false;
      for (const service of ['yandex', 'youtube', 'soundcloud']) {
        for (const name of ['connect', 'disconnect', 'open']) document.getElementById(`account-${service}-${name}`).removeAttribute('aria-disabled');
      }
    }
  }

  savePreferences() {
    try { localStorage.setItem('casOnlinePanel', JSON.stringify({ source: this.source, deck: document.getElementById('onlineTargetDeck').value, open: this.panel.open })); } catch {}
  }

  selectSource(source) {
    this.source = source;
    document.querySelectorAll('[data-online-source]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.onlineSource === source)));
    document.getElementById('onlineSourceHint').textContent = source === 'yandex'
      ? 'Поиск по каталогу Яндекса. Записи с ограниченным доступом и фрагменты в очередь не добавляются.'
      : source === 'all' ? 'Поиск в трёх источниках. Источник ссылки определяется автоматически.'
        : `Поиск в ${ONLINE_SOURCE_NAMES[source]}. Можно вставить ссылку из любого из трёх источников.`;
    this.savePreferences();
  }

  setView(view) {
    this.view = view;
    document.getElementById('onlineSearchControls').hidden = view !== 'search';
    document.getElementById('onlineBrowseButton').setAttribute('aria-pressed', String(view === 'search'));
    document.getElementById('onlineSavedButton').setAttribute('aria-pressed', String(view === 'library'));
  }

  setStatus(message, error = false) {
    this.status.textContent = message;
    this.status.classList.toggle('is-error', error);
    this.hasError = error;
    this.updateSummary();
  }

  setBusy(busy) {
    this.searchBusy = busy;
    const button = document.getElementById('onlineSearchButton');
    button.textContent = busy ? 'Отмена' : 'Найти';
    button.type = busy ? 'button' : 'submit';
    if (busy) this.results.setAttribute('aria-busy', 'true'); else this.results.removeAttribute('aria-busy');
    this.updateSummary();
  }

  updateSummary() {
    const summary = document.getElementById('onlineSummaryState');
    summary.textContent = this.jobs.size ? `Подготовка: ${this.jobs.size}` : this.searchBusy ? 'Поиск…' : this.hasError ? 'Есть ограничение' : this.summaryText || '3 источника';
    summary.classList.toggle('is-working', this.jobs.size > 0 || this.searchBusy);
    summary.classList.toggle('is-error', !!this.hasError && !this.jobs.size && !this.searchBusy);
  }

  showWarnings(warnings = []) {
    const element = document.getElementById('onlineWarnings');
    element.hidden = !warnings.length;
    element.textContent = warnings.map(warning => warning.message).join(' ');
  }

  showSearch() {
    ++this.searchGeneration;
    this.api.cancelOnlineSearch?.();
    this.setBusy(false);
    this.setView('search');
    this.render(this.searchTracks);
    this.showWarnings(this.searchWarnings);
    this.summaryText = this.searchTracks.length ? `Найдено: ${this.searchTracks.length}` : '';
    this.setStatus(this.searchTracks.length ? `Найдено: ${this.searchTracks.length}. Выберите трек для очереди или запуска.` : 'Введите название, исполнителя или ссылку на трек.');
    document.getElementById('onlineQuery').focus();
  }

  cancelSearch() {
    ++this.searchGeneration;
    this.api.cancelOnlineSearch?.();
    this.setBusy(false);
    this.render(this.searchTracks);
    this.showWarnings(this.searchWarnings);
    this.setStatus('Поиск остановлен. Можно изменить запрос или источник.');
  }

  renderLoading() {
    this.results.replaceChildren(); this.rows.clear();
    for (let i = 0; i < 3; i++) {
      const row = document.createElement('li');
      row.className = 'online-skeleton'; row.setAttribute('aria-hidden', 'true');
      for (let j = 0; j < 2; j++) row.append(document.createElement('span'));
      this.results.append(row);
    }
  }

  async search() {
    const query = document.getElementById('onlineQuery').value.trim();
    if (!query) { this.setStatus('Введите название трека или ссылку.', true); return; }
    const generation = ++this.searchGeneration;
    this.setView('search'); this.showWarnings(); this.renderLoading();
    this.setStatus(/^(https?:\/\/|www\.|[\w.-]+\.[a-z]{2,}\/)/i.test(query) ? 'Получаем трек по ссылке…' : this.source === 'all' ? 'Ищем в SoundCloud, Яндекс Музыке и YouTube…' : `Ищем в ${ONLINE_SOURCE_NAMES[this.source]}…`);
    this.setBusy(true);
    try {
      const result = await this.api.searchOnline(query, this.source);
      if (generation !== this.searchGeneration) return;
      if (!result.success) throw new Error(result.error);
      const { tracks, warnings = [] } = Array.isArray(result.data) ? { tracks: result.data } : result.data;
      if (result.data.source) this.selectSource(result.data.source);
      this.searchTracks = tracks; this.searchWarnings = warnings;
      this.render(tracks); this.showWarnings(warnings);
      this.summaryText = `Найдено: ${tracks.length}`;
      this.setStatus(tracks.length ? `Найдено: ${tracks.length}. «Запустить» начнёт воспроизведение после подготовки.` : 'Ничего не найдено. Измените запрос, источник или вставьте ссылку.');
    } catch (error) {
      if (generation === this.searchGeneration) {
        this.renderEmpty('Поиск не завершён', 'Проверьте сеть или выберите другой источник.', 'Повторить поиск', () => this.search());
        this.setStatus(error.message, true);
      }
    } finally { if (generation === this.searchGeneration) this.setBusy(false); }
  }

  async showLibrary() {
    const generation = ++this.searchGeneration;
    this.api.cancelOnlineSearch?.(); this.setBusy(false);
    this.setView('library'); this.showWarnings(); this.renderLoading();
    this.results.setAttribute('aria-busy', 'true');
    this.setStatus('Открываем сохранённые треки…');
    try {
      const result = await this.api.getOnlineLibrary();
      if (generation !== this.searchGeneration) return;
      if (!result.success) throw new Error(result.error);
      this.render(result.data);
      this.summaryText = `Сохранено: ${result.data.length}`;
      const megabytes = Math.round(result.data.reduce((sum, track) => sum + (track.size || 0), 0) / 1024 / 1024);
      this.setStatus(result.data.length ? `Сохранено: ${result.data.length} · ${megabytes} МБ. Доступны без интернета.` : 'Здесь будут подготовленные треки из всех источников.');
    } catch (error) {
      if (generation === this.searchGeneration) {
        this.renderEmpty('Не удалось открыть библиотеку', 'Попробуйте открыть её ещё раз.', 'Повторить', () => this.showLibrary());
        this.setStatus(error.message, true);
      }
    } finally { if (generation === this.searchGeneration) this.results.removeAttribute('aria-busy'); }
  }

  button(label, action, className = '') {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `online-btn ${className}`.trim(); button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  renderEmpty(title, text, actionLabel, action) {
    this.results.replaceChildren(); this.rows.clear();
    const row = document.createElement('li'); row.className = 'online-empty';
    const heading = document.createElement('strong'); heading.textContent = title;
    const description = document.createElement('p'); description.textContent = text;
    row.append(heading, description);
    if (action) row.append(this.button(actionLabel, action));
    this.results.append(row);
  }

  render(tracks) {
    if (!tracks.length) {
      this.renderEmpty(this.view === 'library' ? 'Пока нет сохранённых треков' : 'Музыка для вашей очереди', this.view === 'library' ? 'Подготовьте запись через поиск. Она останется в CAS для следующих запусков.' : 'Найдите трек, выберите деку и добавьте его в очередь. Текущая музыка продолжит играть.');
      return;
    }
    this.results.replaceChildren(); this.rows.clear();
    for (const track of tracks) {
      const row = document.createElement('li'); row.className = 'online-result';
      const source = track.source || 'youtube';
      const badge = document.createElement('span'); badge.className = `online-provider online-provider-${source}`;
      badge.textContent = source === 'soundcloud' ? 'SC' : source === 'yandex' ? 'Я' : 'YT'; badge.setAttribute('aria-hidden', 'true');
      const info = document.createElement('div'); info.className = 'online-track-info';
      const title = document.createElement('strong'); title.textContent = track.title; title.title = track.title;
      const detail = document.createElement('span');
      const duration = track.duration ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, '0')}` : 'Время уточняется';
      detail.textContent = `${track.artist} · ${duration}`;
      const origin = document.createElement('span'); origin.className = 'online-track-origin';
      info.append(title, detail, origin);
      const actions = document.createElement('div'); actions.className = 'online-track-actions';
      const queue = this.button('В очередь', () => this.prepare(track, false));
      const play = this.button('Запустить', () => this.prepare(track, true), 'online-play');
      queue.setAttribute('aria-label', `В очередь: ${track.title}`);
      play.setAttribute('aria-label', `Запустить: ${track.title}`);
      actions.append(queue, play);
      if (this.view === 'library') {
        const remove = this.button('Удалить', () => this.remove(track), 'online-remove');
        remove.setAttribute('aria-label', `Удалить из библиотеки: ${track.title}`);
        actions.append(remove);
      }
      const feedback = document.createElement('div'); feedback.className = 'online-track-feedback'; feedback.hidden = true;
      row.append(badge, info, actions, feedback);
      this.rows.set(track.onlineId, { track, row, actions, origin, feedback });
      this.refreshRow(track.onlineId); this.results.append(row);
    }
  }

  refreshRow(id) {
    const entry = this.rows.get(id);
    if (!entry) return;
    const job = this.jobs.get(id);
    entry.actions.querySelectorAll('button').forEach(button => { button.disabled = !!job; });
    entry.origin.textContent = `${ONLINE_SOURCE_NAMES[entry.track.source || 'youtube']}${entry.track.path ? ' · Сохранён в CAS' : ''}${job ? ` · Подготовка для деки ${job.deckId}` : ''}`;
    const failure = this.failures.get(id);
    entry.feedback.hidden = !failure; entry.feedback.replaceChildren();
    if (failure) {
      const message = document.createElement('p'); message.textContent = failure;
      entry.feedback.append(message, this.button('Найти в других источниках', () => this.findAlternatives(entry.track)));
    }
  }

  findAlternatives(track) {
    document.getElementById('onlineQuery').value = `${track.artist} ${track.title}`.slice(0, 300);
    this.selectSource('all'); this.search();
  }

  async remove(track) {
    const referenced = Object.values(this.mixer.decks).some(deck => deck.tracks.some(item => item.path === track.path)) || Array.from(this.mixer.soundEffects.values()).some(item => item.path === track.path);
    if (referenced) { this.setStatus('Сначала уберите трек из дек и пэдов, затем удалите из библиотеки.', true); return; }
    try {
      const result = await this.api.removeOnlineTrack(track.onlineId);
      if (!result.success) throw new Error(result.error);
      this.searchTracks = this.searchTracks.map(item => item.onlineId === track.onlineId ? { onlineId: item.onlineId, source: item.source, title: item.title, artist: item.artist, duration: item.duration, sourceUrl: item.sourceUrl } : item);
      if (this.view === 'library') await this.showLibrary();
    } catch (error) { this.setStatus(error.message, true); }
  }

  updateProgress({ id, stage, percent }) {
    const job = this.jobs.get(id);
    if (!job || job.cancelled) return;
    job.stage.textContent = stage === 'queued' ? `Ожидает · Дека ${job.deckId}` : stage === 'processing' ? `Подготовка аудио · Дека ${job.deckId}` : `Загрузка${Number.isFinite(percent) ? ` ${Math.round(percent)}%` : '…'} · Дека ${job.deckId}`;
    if (stage === 'downloading' && Number.isFinite(percent)) job.progress.value = percent; else job.progress.removeAttribute('value');
  }

  async prepare(track, autoplay) {
    if (this.jobs.has(track.onlineId)) { this.setStatus('Этот трек уже подготавливается. Дождитесь завершения или отмените подготовку.'); return; }
    const deckId = document.getElementById('onlineTargetDeck').value;
    const target = this.mixer.captureOnlineTarget(deckId, autoplay);
    const row = document.createElement('li'); row.className = 'online-job';
    const info = document.createElement('div'); info.className = 'online-job-info';
    const title = document.createElement('strong'); title.textContent = track.title;
    const stage = document.createElement('span'); stage.textContent = `Подготовка · Дека ${deckId}`;
    const progress = document.createElement('progress'); progress.max = 100; progress.setAttribute('aria-label', `Подготовка: ${track.title}`);
    info.append(title, stage, progress);
    const job = { title: track.title, stage, progress, deckId, cancelled: false };
    const cancel = this.button('Отмена', async () => {
      job.cancelled = true; cancel.disabled = true; stage.textContent = 'Отмена подготовки…';
      try { await this.api.cancelOnlineTrack(track.onlineId); } catch { /* Local intent is cancelled even if IPC has closed. */ }
    });
    cancel.setAttribute('aria-label', `Отмена подготовки: ${track.title}`);
    row.append(info, cancel);
    const jobsElement = document.getElementById('onlineJobs'); jobsElement.hidden = false; jobsElement.append(row);
    this.failures.delete(track.onlineId); this.jobs.set(track.onlineId, job);
    this.refreshRow(track.onlineId); this.updateSummary();
    try {
      const result = await this.api.prepareOnlineTrack(track.onlineId);
      if (job.cancelled) throw new Error('Подготовка отменена');
      if (!result.success || !result.data) throw new Error(result.error || 'Не удалось подготовить трек');
      Object.assign(track, result.data);
      const visibleTrack = this.rows.get(track.onlineId)?.track;
      if (visibleTrack) Object.assign(visibleTrack, result.data);
      const added = this.mixer.insertOnlineTrack(result.data, target, autoplay);
      this.setStatus(added ? `${track.title}: ${autoplay ? 'передан на запуск' : 'добавлен в очередь'} в деке ${deckId}.` : 'Трек сохранён. Плейлист или воспроизведение изменились: добавьте его из «Сохранённых».');
    } catch (error) {
      if (!job.cancelled) this.failures.set(track.onlineId, error.message);
      this.setStatus(error.message, !job.cancelled);
    } finally {
      this.jobs.delete(track.onlineId); row.remove(); jobsElement.hidden = this.jobs.size === 0;
      this.refreshRow(track.onlineId); this.updateSummary();
    }
  }
}
if (typeof window !== 'undefined') window.CASOnlinePanel = CASOnlinePanel;
if (typeof module !== 'undefined') module.exports = { CASOnlinePanel };
