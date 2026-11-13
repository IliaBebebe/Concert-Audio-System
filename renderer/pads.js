(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_CONFIG } = dependencies;

// Pad assignments, lazy sound loading, active sound IDs and effect volume.
class CASPadsController {
    constructor(app) {
        this.app = app;
        this.soundEffects = new Map();
        this.selectedPad = null;
        this.effectsVolume = CAS_CONFIG.AUDIO.DEFAULT_EFFECTS_VOLUME;
        this.effectsVolumeTimeout = null;
        this.padProgressIntervals = new Map();
        this.padActiveSoundIds = new Map();
        this.effectGenerations = new Map();
        this.padLabels = new Map();
    }

    selectPad(index) {
        document.querySelectorAll('.sound-pad').forEach(pad => {
            pad.classList.remove('selected');
        });

        const pad = document.querySelector(`.sound-pad[data-index="${index}"]`);
        if (pad) {
            pad.classList.add('selected');
            this.selectedPad = index;

            const padStatus = document.getElementById('padStatus');
            if (padStatus) padStatus.textContent = `Выбран: ${this.app.getPadLabel(index)}`;
        }
    }

    getPadLabel(padIndex) {
        return this.soundEffects.get(padIndex)?.name || this.padLabels.get(padIndex) || `Пад ${padIndex + 1}`;
    }

    getPadDisplayName(padIndex) {
        if (!this.soundEffects.has(padIndex) && !this.padLabels.has(padIndex)) {
            return String(padIndex + 1);
        }
        const name = this.app.getPadLabel(padIndex);
        return name.length > 12 ? `${name.substring(0, 12)}...` : name;
    }

    updatePadLabel(padIndex) {
        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        if (!pad) return;
        const name = this.app.getPadLabel(padIndex);
        pad.textContent = this.app.getPadDisplayName(padIndex);
        pad.title = name.startsWith('Пад ') ? '' : name;
        pad.setAttribute('aria-label', `Пэд ${padIndex + 1}: ${name}`);
    }

    nextEffectGeneration(padIndex) {
        const generation = (this.effectGenerations.get(padIndex) || 0) + 1;
        this.effectGenerations.set(padIndex, generation);
        return generation;
    }

    isCurrentEffectData(padIndex, soundData, generation = soundData?.generation) {
        return this.soundEffects.get(padIndex) === soundData
            && this.effectGenerations.get(padIndex) === generation
            && soundData?.generation === generation;
    }

    getActivePadSoundIds(padIndex) {
        let ids = this.padActiveSoundIds.get(padIndex);
        if (!ids) {
            ids = new Set();
            this.padActiveSoundIds.set(padIndex, ids);
        }
        return ids;
    }

    disposeEffectData(padIndex, soundData, { unload = true, keepAssignment = false } = {}) {
        const generation = this.app.nextEffectGeneration(padIndex);
        if (soundData) {
            soundData.pendingPlay = false;
            if (soundData.loadingSound) {
                try { soundData.loadingSound.stop(); } catch {}
                try { soundData.loadingSound.unload(); } catch {}
                soundData.loadingSound = null;
            }
            if (soundData.sound) {
                try { soundData.sound.stop(); } catch {}
                if (unload) {
                    try { soundData.sound.unload(); } catch {}
                    soundData.sound = null;
                }
            }
            if (keepAssignment) soundData.generation = generation;
        }

        this.padActiveSoundIds.delete(padIndex);
        this.app.stopPadProgress(padIndex);
        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        pad?.classList.remove('playing');
        return generation;
    }

    async assignSoundToPad() {
        if (this.selectedPad === null) {
            this.app.updateStatus('Сначала выберите пад правой кнопкой мыши');
            return;
        }

        try {
            const result = await window.electronAPI.openFileDialog({
                title: 'Выберите звуковой эффект',
                filters: [
                    { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }
                ],
                properties: ['openFile']
            });

            if (!result.canceled && result.filePaths.length > 0) {
                const filePath = result.filePaths[0];
                await this.app.assignSound(this.selectedPad, filePath);
            }
        } catch (error) {
            this.app.updateStatus('Ошибка выбора файла');
        }
    }

    async assignSound(padIndex, filePath, { name: savedName, persist = true } = {}) {
        try {
            if (!Number.isInteger(padIndex) || padIndex < 0 || padIndex > 11 || typeof filePath !== 'string' || !filePath) {
                throw new Error('Некорректные данные звукового эффекта');
            }

            const fileName = filePath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, "");
            const name = typeof savedName === 'string' && savedName.trim() ? savedName.trim() : fileName;
            const previous = this.soundEffects.get(padIndex);
            if (previous) this.app.disposeEffectData(padIndex, previous);

            const generation = this.app.nextEffectGeneration(padIndex);
            this.padLabels.set(padIndex, name);
            this.soundEffects.set(padIndex, {
                sound: null,
                loadingSound: null,
                pendingPlay: false,
                generation,
                name,
                path: filePath
            });

            this.app.updatePadLabel(padIndex);

            this.app.updateStatus(`Звук "${name}" назначен на пад ${padIndex + 1}`, 'success');
            if (persist) this.app.saveStoredData();
        } catch (error) {
            this.app.updateStatus('Ошибка назначения звука', 'error');
        }
    }

    renameSelectedPad() {
        if (this.selectedPad === null) {
            this.app.updateStatus('Сначала выберите пад правой кнопкой мыши', 'warning');
            return;
        }

        const padIndex = this.selectedPad;
        const current = this.app.getPadLabel(padIndex);
        document.querySelector('.metadata-modal-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'metadata-modal-overlay';
        overlay.innerHTML = `<form class="metadata-modal" role="dialog" aria-modal="true" aria-label="Название пэда">
            <div class="metadata-modal-header"><h3>Название пэда</h3>
                <button type="button" class="metadata-close-btn" aria-label="Закрыть"><i class="fas fa-times"></i></button></div>
            <label class="metadata-field"><span>Название</span><input name="name" maxlength="200" autocomplete="off"></label>
            <div class="metadata-actions"><button type="button" class="metadata-secondary-btn">Отмена</button>
                <button type="submit" class="metadata-primary-btn">Сохранить</button></div></form>`;
        const input = overlay.querySelector('input');
        input.value = current;
        const close = this.app.setupDialogKeyboard(overlay);
        overlay.querySelector('.metadata-close-btn').addEventListener('click', close);
        overlay.querySelector('.metadata-secondary-btn').addEventListener('click', close);
        overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
        overlay.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            const normalizedName = input.value.trim() || `Пад ${padIndex + 1}`;
            const soundData = this.soundEffects.get(padIndex);
            if (soundData) soundData.name = normalizedName;
            this.padLabels.set(padIndex, normalizedName);
            this.app.updatePadLabel(padIndex);
            const padStatus = document.getElementById('padStatus');
            if (padStatus) padStatus.textContent = `Выбран: ${normalizedName}`;
            this.app.saveStoredData();
            close();
        });
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    }

    playSoundEffect(padIndex) {
        const soundData = this.soundEffects.get(padIndex);
        if (!soundData || !soundData.path) {
            this.app.updateStatus('Пад не настроен', 'warning');
            return;
        }

        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        this.app.animatePadPress(pad);

        if (soundData.sound) {
            this.app.playLoadedEffect(padIndex, soundData, soundData.sound, pad);
            return;
        }

        if (soundData.loadingSound) {
            soundData.pendingPlay = true;
            this.app.updateStatus(`Загрузка: ${soundData.name}...`);
            return;
        }

        const generation = this.app.nextEffectGeneration(padIndex);
        soundData.generation = generation;
        soundData.pendingPlay = true;
        this.app.updateStatus(`Загрузка: ${soundData.name}...`);

        let sound = null;
        try {
            sound = new Howl({
                src: [this.app.toSafeAudioSource(soundData.path)],
                format: this.app.getAudioFormat(soundData.path),
                volume: this.effectsVolume,
                mute: this.app.isMuted,
                html5: true,
                onplay: () => {
                    if (this.app.isCurrentEffectData(padIndex, soundData, generation)) this.app.updateVuMeters();
                },
                onload: () => {
                    if (!this.app.isCurrentEffectData(padIndex, soundData, generation)) {
                        try { sound.unload(); } catch {}
                        return;
                    }
                    soundData.loadingSound = null;
                    soundData.sound = sound;
                    try {
                        sound.volume(this.effectsVolume);
                        sound.mute(this.app.isMuted);
                    } catch {}
                    this.app.connectHowlToAnalyser(sound, 'effects');
                    if (!soundData.pendingPlay) return;
                    soundData.pendingPlay = false;
                    this.app.playLoadedEffect(padIndex, soundData, sound, pad);
                },
                onloaderror: () => {
                    if (!this.app.isCurrentEffectData(padIndex, soundData, generation)) return;
                    soundData.loadingSound = null;
                    soundData.pendingPlay = false;
                    try { sound.unload(); } catch {}
                    this.app.updateStatus(`Ошибка загрузки: ${soundData.name}`, 'error');
                },
                onplayerror: () => {
                    if (this.soundEffects.get(padIndex) === soundData && soundData.sound === sound) {
                        this.app.updateStatus('Ошибка воспроизведения эффекта', 'error');
                    }
                }
            });
            soundData.loadingSound = sound;
        } catch {
            soundData.pendingPlay = false;
            this.app.updateStatus('Ошибка воспроизведения эффекта', 'error');
        }
    }

    playLoadedEffect(padIndex, soundData, sound, pad) {
        const generation = soundData.generation;
        if (!this.app.isCurrentEffectData(padIndex, soundData, generation) || soundData.sound !== sound) return;

        try {
            this.app.resumeAudioContext();
            sound.mute(this.app.isMuted);
            sound.volume(this.effectsVolume);
            const soundId = sound.play();
            if (soundId === null || soundId === undefined) {
                throw new Error('Не удалось запустить эффект');
            }

            setTimeout(() => {
                if (this.app.isCurrentEffectData(padIndex, soundData, generation)) {
                    this.app.connectHowlToAnalyser(sound, 'effects');
                }
            }, 0);

            const activeIds = this.app.getActivePadSoundIds(padIndex);
            activeIds.add(soundId);
            pad?.classList.add('playing');
            const duration = sound.duration();
            if (duration && duration > 0) this.app.startPadProgress(padIndex, duration);

            const finish = () => {
                ['end', 'stop', 'playerror'].forEach(event => sound.off?.(event, finish, soundId));
                this.app.finishPadSound(padIndex, soundData, generation, soundId);
            };
            sound.once('end', finish, soundId);
            sound.once('stop', finish, soundId);
            sound.once('playerror', finish, soundId);
            this.app.updateStatus(`Эффект: ${soundData.name}`, 'success');
        } catch {
            // An earlier overlapping effect may still be playing.
            this.app.finishPadSound(padIndex, soundData, generation);
            this.app.updateStatus('Ошибка воспроизведения эффекта', 'error');
        }
    }

    finishPadSound(padIndex, soundData, generation, soundId) {
        if (!this.app.isCurrentEffectData(padIndex, soundData, generation)) return;
        const activeIds = this.padActiveSoundIds.get(padIndex);
        if (soundId !== undefined) activeIds?.delete(soundId);
        if (activeIds?.size) return;

        this.padActiveSoundIds.delete(padIndex);
        this.app.stopPadProgress(padIndex);
        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        pad?.classList.remove('playing');
    }

    startPadProgress(padIndex, duration) {
        this.app.stopPadProgress(padIndex);

        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        if (!pad) return;
        const progressBar = document.createElement('div');
        progressBar.className = 'pad-progress-bar';
        progressBar.setAttribute('aria-hidden', 'true');
        progressBar.style.transform = 'scaleX(0)';
        pad.appendChild(progressBar);

        const startTime = Date.now();
        const updateProgress = () => {
            if (this.app.isVisualsHidden()) return;
            if (!pad.isConnected || !pad.classList.contains('playing')) {
                this.app.stopPadProgress(padIndex);
                return;
            }

            const elapsed = (Date.now() - startTime) / 1000;
            const progress = Math.min(100, (elapsed / duration) * 100);

            progressBar.style.transform = `scaleX(${progress / 100})`;

            if (progress >= 100) {
                this.app.stopPadProgress(padIndex);
            }
        };

        const intervalId = setInterval(updateProgress, 50);
        this.padProgressIntervals.set(padIndex, intervalId);
    }

    stopPadProgress(padIndex) {
        const intervalId = this.padProgressIntervals.get(padIndex);
        if (intervalId) {
            clearInterval(intervalId);
            this.padProgressIntervals.delete(padIndex);
        }

        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        if (pad) {
            const progressBar = pad.querySelector('.pad-progress-bar');
            if (progressBar) {
                progressBar.remove();
            }
        }
    }

    animatePadPress(pad) {
        if (pad) {
            pad.classList.add('pressed');
            setTimeout(() => {
                pad.classList.remove('pressed');
            }, 150);
        }
    }

    clearSelectedPad() {
        if (this.selectedPad !== null) {
            const padIndex = this.selectedPad;
            const soundData = this.soundEffects.get(padIndex);
            this.app.disposeEffectData(padIndex, soundData);
            this.soundEffects.delete(padIndex);
            this.padLabels.delete(padIndex);
            const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
            if (pad) {
                this.app.updatePadLabel(padIndex);
                pad.title = '';
                pad.classList.remove('selected', 'playing');
            }

            this.app.updateStatus(`Пад ${padIndex + 1} очищен`, 'success');
            this.selectedPad = null;
            const padStatus = document.getElementById('padStatus');
            if (padStatus) {
                padStatus.textContent = 'Выберите пад правой кнопкой';
            }

            this.app.saveStoredData();
        } else {
            this.app.updateStatus('Сначала выберите пад правой кнопкой мыши', 'warning');
        }
    }

    stopAllEffects() {
        let stoppedCount = 0;
        this.soundEffects.forEach((soundData, padIndex) => {
            const wasPlaying = Boolean(soundData?.sound?.playing?.());
            this.app.disposeEffectData(padIndex, soundData, { unload: false, keepAssignment: true });
            if (wasPlaying) stoppedCount++;
        });

        document.querySelectorAll('.sound-pad').forEach(pad => {
            pad.classList.remove('playing');
            const progressBar = pad.querySelector('.pad-progress-bar');
            if (progressBar) {
                progressBar.remove();
            }
        });

        this.app.updateStatus(`Остановлено эффектов: ${stoppedCount}`, 'success');
    }

    setEffectsVolume(volume) {
        volume = Math.max(0, Math.min(1, Number(volume) || 0));
        this.effectsVolume = volume;

        const volumeValueEl = typeof document !== 'undefined' ? document.getElementById('effectsVolumeValue') : null;
        if (volumeValueEl) {
            volumeValueEl.textContent = `${Math.round(volume * 100)}%`;
        }

        if (this.effectsVolumeTimeout) {
            clearTimeout(this.effectsVolumeTimeout);
        }

        this.effectsVolumeTimeout = setTimeout(() => {
            this.soundEffects.forEach(soundData => {
                if (soundData?.sound) {
                    try {
                        soundData.sound.volume(volume);
                    } catch (error) {
                        console.warn('Ошибка установки громкости эффекта:', error);
                    }
                }
                if (soundData?.loadingSound) {
                    try { soundData.loadingSound.volume(volume); } catch {}
                }
            });
            this.app.saveStoredData();
        }, 50);
    }

    createSoundPads() {
        const grid = document.getElementById('soundPadsGrid');
        if (!grid) return;
        grid.innerHTML = '';

        for (let i = 0; i < 12; i++) {
            const pad = document.createElement('button');
            pad.type = 'button';
            pad.className = 'sound-pad';
            pad.textContent = this.app.getPadDisplayName(i);
            pad.dataset.index = i;
            pad.dataset.key = i + 1;
            pad.setAttribute('aria-label', `Пэд ${i + 1}: ${this.app.getPadLabel(i)}`);
            pad.addEventListener('focus', () => this.app.selectPad(i));

            pad.addEventListener('click', () => this.app.playSoundEffect(i));
            pad.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.app.selectPad(i);
            });

            grid.appendChild(pad);
        }
    }
}

    return { CASPadsController };
});
