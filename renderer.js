(function() {
    const application = typeof module !== 'undefined' && module.exports
        ? require('./renderer/app.js')
        : globalThis.CASRenderer;
    const { TheatreSoundMixer, CAS_LOGGER } = application;

    // Инициализация приложения
    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            window.soundMixer = new TheatreSoundMixer();
        });
    }

    // Очистка ресурсов при закрытии окна
    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => {
            if (window.soundMixer) {
                window.soundMixer.stopMusic();
                window.soundMixer.stopAllEffects();

                if (window.soundMixer.clockInterval) {
                    clearInterval(window.soundMixer.clockInterval);
                }
                if (window.soundMixer.remoteStateInterval) {
                    clearInterval(window.soundMixer.remoteStateInterval);
                }
                if (window.soundMixer.progressAnimationFrame) {
                    cancelAnimationFrame(window.soundMixer.progressAnimationFrame);
                }
                if (window.soundMixer.volumeUpdateTimeout) {
                    clearTimeout(window.soundMixer.volumeUpdateTimeout);
                }
                if (window.soundMixer.musicVolumeTimeout) {
                    clearTimeout(window.soundMixer.musicVolumeTimeout);
                }
                if (window.soundMixer.effectsVolumeTimeout) {
                    clearTimeout(window.soundMixer.effectsVolumeTimeout);
                }
                if (window.soundMixer.statusUpdateTimeout) {
                    clearTimeout(window.soundMixer.statusUpdateTimeout);
                }
                if (window.soundMixer.countdownInterval) {
                    clearInterval(window.soundMixer.countdownInterval);
                }
                if (window.soundMixer.vuMeterInterval) {
                    clearInterval(window.soundMixer.vuMeterInterval);
                }

                if (window.soundMixer.musicPlayer) {
                    try {
                        window.soundMixer.musicPlayer.unload();
                    } catch (e) {
                        CAS_LOGGER.debug('Ошибка выгрузки musicPlayer при beforeunload:', e);
                    }
                }

                window.soundMixer.soundEffects.forEach((soundData) => {
                    if (soundData?.sound) {
                        try {
                            soundData.sound.unload();
                        } catch (e) {
                            CAS_LOGGER.debug('Ошибка выгрузки soundEffect при beforeunload:', e);
                        }
                    }
                });

                window.soundMixer.stopBackgroundCrossfadeTracking();
                window.soundMixer.unsubscribeWindowVisibility?.();
                if (window.soundMixer.waveformResizeObserver) {
                    window.soundMixer.waveformResizeObserver.disconnect();
                }

                window.soundMixer.closeAudioAnalysers();
                window.soundMixer.saveStoredDataImmediate();
            }
        });

        // Обработка ошибок на уровне приложения
        window.addEventListener('error', (event) => {
            CAS_LOGGER.error('Глобальная ошибка приложения:', event.error || event.message);
            if (window.soundMixer) {
                window.soundMixer.updateStatus('Произошла ошибка приложения', 'error');
            }
        });

        window.addEventListener('unhandledrejection', (event) => {
            CAS_LOGGER.error('Необработанный Promise rejection:', event.reason);
            if (window.soundMixer) {
                window.soundMixer.updateStatus('Ошибка выполнения операции', 'error');
            }
        });
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = application;
})();
