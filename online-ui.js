/* The network stays in main. This panel only requests metadata and ready local files. */
class CASOnlinePanel {
  constructor(mixer) {
    this.mixer = mixer;
    this.api = window.electronAPI;
    this.results = document.getElementById('onlineResults');
    this.status = document.getElementById('onlineStatus');
    this.jobs = new Map();
    this.searchGeneration = 0;
    document.getElementById('onlineSearchForm').addEventListener('submit', event => {
      event.preventDefault(); this.search();
    });
    document.getElementById('onlineSavedButton').addEventListener('click', () => this.showLibrary());
    document.getElementById('onlineFolderButton').addEventListener('click', async () => {
      const result = await this.api.openOnlineLibrary();
      if (!result.success) this.status.textContent = result.error;
    });
    this.api.onOnlineProgress(progress => this.updateProgress(progress));
  }

  async search() {
    const query = document.getElementById('onlineQuery').value.trim();
    if (!query) { this.status.textContent = 'Введите название трека или ссылку.'; return; }
    const generation = ++this.searchGeneration;
    const button = document.getElementById('onlineSearchButton');
    button.disabled = true;
    this.status.textContent = 'Поиск в YouTube…';
    this.results.setAttribute('aria-busy', 'true');
    try {
      const result = await this.api.searchOnline(query);
      if (generation !== this.searchGeneration) return;
      if (!result.success) throw new Error(result.error);
      this.render(result.data);
      this.status.textContent = result.data.length ? `Найдено: ${result.data.length}. «Запустить» подготовит трек и начнёт воспроизведение.` : 'Ничего не найдено. Уточните запрос или вставьте ссылку.';
    } catch (error) { if (generation === this.searchGeneration) this.status.textContent = error.message; }
    finally {
      if (generation === this.searchGeneration) {
        button.disabled = false;
        this.results.removeAttribute('aria-busy');
      }
    }
  }

  async showLibrary() {
    const generation = ++this.searchGeneration;
    document.getElementById('onlineSearchButton').disabled = false;
    this.results.setAttribute('aria-busy', 'true');
    try {
      const result = await this.api.getOnlineLibrary();
      if (generation !== this.searchGeneration) return;
      if (!result.success) throw new Error(result.error);
      this.render(result.data);
      const megabytes = Math.round(result.data.reduce((sum, track) => sum + (track.size || 0), 0) / 1024 / 1024);
      this.status.textContent = result.data.length ? `Сохранено: ${result.data.length} · ${megabytes} МБ. Доступны без интернета.` : 'Библиотека пуста. Найдите и подготовьте первый трек.';
    } catch (error) {
      if (generation === this.searchGeneration) this.status.textContent = error.message;
    } finally {
      if (generation === this.searchGeneration) this.results.removeAttribute('aria-busy');
    }
  }

  button(label, action) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'deck-view-btn'; button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  render(tracks) {
    this.results.replaceChildren();
    for (const track of tracks) {
      const row = document.createElement('div'); row.className = 'online-result';
      const info = document.createElement('div'); info.className = 'online-track-info';
      const title = document.createElement('strong'); title.textContent = track.title;
      const detail = document.createElement('span');
      const duration = track.duration ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, '0')}` : 'Длительность уточняется';
      detail.textContent = `${track.artist} · ${duration} · ${track.path ? 'Сохранено' : 'YouTube'}`;
      info.append(title, detail);
      row.append(info, this.button('В очередь', () => this.prepare(track, false)), this.button('Запустить', () => this.prepare(track, true)));
      if (track.path) {
        const remove = this.button('Удалить', async () => {
          const referenced = Object.values(this.mixer.decks).some(deck => deck.tracks.some(item => item.path === track.path)) || Array.from(this.mixer.soundEffects.values()).some(item => item.path === track.path);
          if (referenced) { this.status.textContent = 'Сначала уберите трек из дек и пэдов, затем удалите из библиотеки.'; return; }
          const result = await this.api.removeOnlineTrack(track.onlineId);
          if (result.success) this.showLibrary(); else this.status.textContent = result.error;
        });
        row.append(remove);
      }
      this.results.append(row);
    }
  }

  updateProgress({ id, stage, percent }) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.label.textContent = `${job.title}: ${stage === 'queued' ? 'в очереди подготовки' : stage === 'processing' ? 'обработка аудио' : `загрузка${Number.isFinite(percent) ? ` ${Math.round(percent)}%` : '…'}`}`;
  }

  async prepare(track, autoplay) {
    if (this.jobs.has(track.onlineId)) { this.status.textContent = 'Этот трек уже подготавливается.'; return; }
    const deckId = document.getElementById('onlineTargetDeck').value;
    const target = this.mixer.captureOnlineTarget(deckId, autoplay);
    const row = document.createElement('div'); row.className = 'online-job';
    const label = document.createElement('span'); label.textContent = `${track.title}: подготовка…`;
    const job = { label, title: track.title, cancelled: false };
    const cancel = this.button('Отмена', () => {
      job.cancelled = true;
      this.api.cancelOnlineTrack(track.onlineId);
      cancel.disabled = true;
    });
    row.append(label, cancel);
    document.getElementById('onlineJobs').append(row);
    this.jobs.set(track.onlineId, job);
    try {
      const result = track.path ? { success: true, data: track } : await this.api.prepareOnlineTrack(track.onlineId);
      if (job.cancelled) throw new Error('Подготовка отменена');
      if (!result.success || !result.data) throw new Error(result.error || 'Не удалось подготовить трек');
      const added = this.mixer.insertOnlineTrack(result.data, target, autoplay);
      this.status.textContent = added ? `${track.title}: ${autoplay ? 'запуск' : 'добавлен в очередь'} в деке ${deckId}` : 'Трек сохранён. Плейлист или воспроизведение изменились: добавьте его из «Сохранённых».';
    } catch (error) { this.status.textContent = error.message; }
    finally { this.jobs.delete(track.onlineId); row.remove(); }
  }
}
if (typeof window !== 'undefined') window.CASOnlinePanel = CASOnlinePanel;
if (typeof module !== 'undefined') module.exports = { CASOnlinePanel };
