(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(Object.assign({},
            require('./config.js'),
            require('./peak-meter.js'),
            require('./deck-manager.js'),
            require('./audio.js'),
            require('./layout.js'),
            require('./shell.js'),
            require('./controls.js'),
            require('./remote.js'),
            require('./library.js'),
            require('./decks.js'),
            require('./playback.js'),
            require('./crossfade.js'),
            require('./waveform.js'),
            require('./pads.js'),
            require('./storage.js')
        ));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const {
    CAS_CONFIG,
    CAS_LOGGER,
    CASDeckManager,
    CASPeakMeter,
    CASAudioController,
    CASLayoutController,
    CASShellController,
    CASControlsController,
    CASRemoteController,
    CASLibraryController,
    CASDecksController,
    CASPlaybackController,
    CASCrossfadeController,
    CASWaveformController,
    CASPadsController,
    CASStorageController
} = dependencies;

// Coordinates startup and preserves the public mixer API used by panels and tests.
// Feature controllers own their state; these explicit accessors are compatibility adapters.
class TheatreSoundMixer {
    constructor() {
        this._audioController = new CASAudioController(this);
        this._layoutController = new CASLayoutController(this);
        this._shellController = new CASShellController(this);
        this._controlsController = new CASControlsController(this);
        this._remoteController = new CASRemoteController(this);
        this._libraryController = new CASLibraryController(this);
        this._decksController = new CASDecksController(this);
        this._playbackController = new CASPlaybackController(this);
        this._crossfadeController = new CASCrossfadeController(this);
        this._waveformController = new CASWaveformController(this);
        this._padsController = new CASPadsController(this);
        this._storageController = new CASStorageController(this);
        this.config = null;
        this.setupVisibilityHandlers();
        this.ready = this.startApp();
    }

    get activeDeck() {
        return this.deckManager.activeDeck;
    }

    set activeDeck(val) {
        this.deckManager.setActiveDeck(val);
    }

    get playingDeck() {
        return this.deckManager.playingDeck;
    }

    set playingDeck(val) {
        this.deckManager.setPlayingDeck(val);
    }

    get viewMode() {
        return this.deckManager.viewMode;
    }

    set viewMode(val) {
        this.deckManager.viewMode = val;
    }

    get dragState() {
        return this.deckManager.dragState;
    }

    set dragState(val) {
        this.deckManager.dragState = val;
    }

    get currentDeck() {
        return this.deckManager.getCurrentDeck();
    }

    get playlistTracks() {
        return this.currentDeck?.tracks || [];
    }

    set playlistTracks(tracks) {
        if (this.currentDeck) {
            this.currentDeck.tracks = Array.isArray(tracks) ? tracks : [];
        }
    }

    get currentPlaylist() {
        return this.currentDeck?.playlist || null;
    }

    set currentPlaylist(playlist) {
        if (this.currentDeck) {
            this.currentDeck.playlist = playlist;
        }
    }

    get currentTrackIndex() {
        return this.currentDeck?.currentTrackIndex || 0;
    }

    set currentTrackIndex(index) {
        if (this.currentDeck) {
            this.currentDeck.currentTrackIndex = Number.isInteger(index) ? index : 0;
        }
    }

    get trackFilterQuery() {
        return this.currentDeck?.filterQuery || '';
    }

    set trackFilterQuery(query) {
        if (this.currentDeck) {
            this.currentDeck.filterQuery = typeof query === 'string' ? query : '';
        }
    }

    isVisualsHidden() {
        return Boolean(this.isWindowHidden || document.hidden);
    }

    setupVisibilityHandlers() {
        const updateVisibility = () => {
            if (this.isVisualsHidden()) {
                this.pauseVuMeters();
                this.stopProgressTracking(false);
                if (this.isPlaying && !this.isPaused) {
                    this.startBackgroundCrossfadeTracking();
                }
            } else {
                this.stopBackgroundCrossfadeTracking();
                this.startVuMeters();
                if (this.isPlaying && !this.isPaused) {
                    this.startProgressTracking();
                }
            }
        };
        document.addEventListener('visibilitychange', updateVisibility);
        // With backgroundThrottling disabled, Chromium stays "visible" when
        // minimized. Native window events stop graphics without slowing audio timers.
        this.unsubscribeWindowVisibility = window.electronAPI?.onWindowVisibilityChange?.(visible => {
            this.isWindowHidden = !visible;
            updateVisibility();
        });
    }

    async startApp() {
        try {
            await this.initializeApp();
            // Font metrics and the restored layout must settle behind the logo.
            if (document.fonts?.ready) await document.fonts.ready;
            if (typeof requestAnimationFrame === 'function') {
                await new Promise(resolve => {
                    let frame;
                    const finish = () => {
                        clearTimeout(timeout);
                        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
                        resolve();
                    };
                    // Hidden/occluded windows can stop producing frames during navigation.
                    // Data and fonts are ready; layout settling must not block startup forever.
                    const timeout = setTimeout(finish, 250);
                    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
                });
            }
            document.body.classList.remove('app-starting');
            const shell = document.getElementById('appShell');
            if (shell) { shell.inert = false; shell.setAttribute('aria-busy', 'false'); }
            const screen = document.getElementById('startupScreen');
            if (screen) screen.hidden = true;
            this.startupState = 'ready';
            return true;
        } catch (error) {
            CAS_LOGGER.error('Ошибка подготовки приложения:', error);
            this.startupState = 'error';
            const screen = document.getElementById('startupScreen');
            if (screen) screen.dataset.state = 'error';
            const message = document.getElementById('startupMessage');
            if (message) message.textContent = 'Не удалось подготовить рабочее пространство. Повторите запуск.';
            const retry = document.getElementById('startupRetry');
            if (retry) { retry.hidden = false; retry.onclick = () => window.location.reload(); }
            return false;
        }
    }

    async initializeApp() {
        await this.loadConfig();
        this.setupEventListeners();
        this.createSoundPads();
        this.setupResizers();
        this.setupDetachableBlocks();
        if (window.CASWorkspaceController) this.workspaces = new window.CASWorkspaceController(this);
        this.setupWaveformCanvas();
        this.initVuMeters();
        this.startClock();
        this.updateCountdownDisplay();
        await this.loadStoredData();
        this.updateCrossfadeControls();
        this.initSettingsUI();
        await this.refreshPlaylists();
        this.initWindowControls();
        this.setupAppMenuBar();
        this.initRemoteControl();
        this.setupAboutDialog();
        this.updateDeckUI();
        this.displayTracks();
        if (window.CASOnlinePanel) this.onlinePanel = new window.CASOnlinePanel(this);
        const initialTracks = [...new Set(['A', 'B'].flatMap(id => this.decks[id].tracks))];
        await Promise.all(initialTracks.flatMap(track => [
            this.loadTrackMetadata(track), this.loadTrackDuration(track)
        ]));
        if (this.waveformLoadTask) await this.waveformLoadTask;
    }

    async loadConfig() {
        try {
            this.config = await window.electronAPI.getConfig();
        } catch (error) {
            this.config = { firstRun: false, musicFolder: null };
        }
    }

    get audioController() {
        return this._audioController ||= new CASAudioController(this);
    }

    get vuMeterInterval() { return this.audioController.vuMeterInterval; }
    set vuMeterInterval(value) { this.audioController.vuMeterInterval = value; }

    get audioContext() { return this.audioController.audioContext; }
    set audioContext(value) { this.audioController.audioContext = value; }

    get musicAnalyser() { return this.audioController.musicAnalyser; }
    set musicAnalyser(value) { this.audioController.musicAnalyser = value; }

    get effectsAnalyser() { return this.audioController.effectsAnalyser; }
    set effectsAnalyser(value) { this.audioController.effectsAnalyser = value; }

    get musicNormalizerGain() { return this.audioController.musicNormalizerGain; }
    set musicNormalizerGain(value) { this.audioController.musicNormalizerGain = value; }

    get musicCompressor() { return this.audioController.musicCompressor; }
    set musicCompressor(value) { this.audioController.musicCompressor = value; }

    get musicNodesConnected() { return this.audioController.musicNodesConnected; }
    set musicNodesConnected(value) { this.audioController.musicNodesConnected = value; }

    get musicAnalyserData() { return this.audioController.musicAnalyserData; }
    set musicAnalyserData(value) { this.audioController.musicAnalyserData = value; }

    get effectsAnalyserData() { return this.audioController.effectsAnalyserData; }
    set effectsAnalyserData(value) { this.audioController.effectsAnalyserData = value; }

    get connectedAudioNodes() { return this.audioController.connectedAudioNodes; }
    set connectedAudioNodes(value) { this.audioController.connectedAudioNodes = value; }

    get audioSources() { return this.audioController.audioSources; }
    set audioSources(value) { this.audioController.audioSources = value; }

    get audioSourceTypes() { return this.audioController.audioSourceTypes; }
    set audioSourceTypes(value) { this.audioController.audioSourceTypes = value; }

    get audioSettings() { return this.audioController.audioSettings; }
    set audioSettings(value) { this.audioController.audioSettings = value; }

    get silenceBoundsCache() { return this.audioController.silenceBoundsCache; }
    set silenceBoundsCache(value) { this.audioController.silenceBoundsCache = value; }

    get levelMeters() { return this.audioController.levelMeters; }
    set levelMeters(value) { this.audioController.levelMeters = value; }

    get meterDisplays() { return this.audioController.meterDisplays; }
    set meterDisplays(value) { this.audioController.meterDisplays = value; }

    get meterChannels() { return this.audioController.meterChannels; }
    set meterChannels(value) { this.audioController.meterChannels = value; }

    initVuMeters(...args) {
        return this.audioController.initVuMeters(...args);
    }

    setupAudioAnalysers(...args) {
        return this.audioController.setupAudioAnalysers(...args);
    }

    applyStabilizerSettings(...args) {
        return this.audioController.applyStabilizerSettings(...args);
    }

    updateTrackNormalization(...args) {
        return this.audioController.updateTrackNormalization(...args);
    }

    resumeAudioContext(...args) {
        return this.audioController.resumeAudioContext(...args);
    }

    connectHowlToAnalyser(...args) {
        return this.audioController.connectHowlToAnalyser(...args);
    }

    closeAudioAnalysers(...args) {
        return this.audioController.closeAudioAnalysers(...args);
    }

    startVuMeters(...args) {
        return this.audioController.startVuMeters(...args);
    }

    pauseVuMeters(...args) {
        return this.audioController.pauseVuMeters(...args);
    }

    renderLevelMeter(...args) {
        return this.audioController.renderLevelMeter(...args);
    }

    updateVuMeters(...args) {
        return this.audioController.updateVuMeters(...args);
    }

    getTrackEffectiveStart(...args) {
        return this.audioController.getTrackEffectiveStart(...args);
    }

    getTrackEffectiveEnd(...args) {
        return this.audioController.getTrackEffectiveEnd(...args);
    }

    detectSilenceBounds(...args) {
        return this.audioController.detectSilenceBounds(...args);
    }

    refreshAudioAnalysis(...args) {
        return this.audioController.refreshAudioAnalysis(...args);
    }

    get layoutController() {
        return this._layoutController ||= new CASLayoutController(this);
    }

    get detachedBlocks() { return this.layoutController.detachedBlocks; }
    set detachedBlocks(value) { this.layoutController.detachedBlocks = value; }

    get floatingWindowZ() { return this.layoutController.floatingWindowZ; }
    set floatingWindowZ(value) { this.layoutController.floatingWindowZ = value; }

    get modalCloseMs() { return this.layoutController.modalCloseMs; }
    set modalCloseMs(value) { this.layoutController.modalCloseMs = value; }

    getResponsivePanelWidths(...args) {
        return this.layoutController.getResponsivePanelWidths(...args);
    }

    setupResizers(...args) {
        return this.layoutController.setupResizers(...args);
    }

    setupBlockHeightPersistence(...args) {
        return this.layoutController.setupBlockHeightPersistence(...args);
    }

    setupDetachableBlocks(...args) {
        return this.layoutController.setupDetachableBlocks(...args);
    }

    readCssDuration(...args) {
        return this.layoutController.readCssDuration(...args);
    }

    getFloatingWindowLayer(...args) {
        return this.layoutController.getFloatingWindowLayer(...args);
    }

    detachBlock(...args) {
        return this.layoutController.detachBlock(...args);
    }

    positionFloatingWindow(...args) {
        return this.layoutController.positionFloatingWindow(...args);
    }

    setFloatingWindowGeometry(...args) {
        return this.layoutController.setFloatingWindowGeometry(...args);
    }

    bindFloatingWindowControls(...args) {
        return this.layoutController.bindFloatingWindowControls(...args);
    }

    bringFloatingWindowToFront(...args) {
        return this.layoutController.bringFloatingWindowToFront(...args);
    }

    restoreDetachedBlock(...args) {
        return this.layoutController.restoreDetachedBlock(...args);
    }

    toggleFloatingWindowMinimized(...args) {
        return this.layoutController.toggleFloatingWindowMinimized(...args);
    }

    toggleFloatingWindowMaximized(...args) {
        return this.layoutController.toggleFloatingWindowMaximized(...args);
    }

    startFloatingWindowDrag(...args) {
        return this.layoutController.startFloatingWindowDrag(...args);
    }

    startFloatingWindowResize(...args) {
        return this.layoutController.startFloatingWindowResize(...args);
    }

    clampFloatingWindows(...args) {
        return this.layoutController.clampFloatingWindows(...args);
    }

    get shellController() {
        return this._shellController ||= new CASShellController(this);
    }

    get statusUpdateTimeout() { return this.shellController.statusUpdateTimeout; }
    set statusUpdateTimeout(value) { this.shellController.statusUpdateTimeout = value; }

    get clockInterval() { return this.shellController.clockInterval; }
    set clockInterval(value) { this.shellController.clockInterval = value; }

    get countdownTime() { return this.shellController.countdownTime; }
    set countdownTime(value) { this.shellController.countdownTime = value; }

    get countdownInterval() { return this.shellController.countdownInterval; }
    set countdownInterval(value) { this.shellController.countdownInterval = value; }

    get isCountdownRunning() { return this.shellController.isCountdownRunning; }
    set isCountdownRunning(value) { this.shellController.isCountdownRunning = value; }

    initWindowControls(...args) {
        return this.shellController.initWindowControls(...args);
    }

    setupAppMenuBar(...args) {
        return this.shellController.setupAppMenuBar(...args);
    }

    openTrackForDeck(...args) {
        return this.shellController.openTrackForDeck(...args);
    }

    formatPlatformInfo(...args) {
        return this.shellController.formatPlatformInfo(...args);
    }

    setupAboutDialog(...args) {
        return this.shellController.setupAboutDialog(...args);
    }

    showAboutDialog(...args) {
        return this.shellController.showAboutDialog(...args);
    }

    updateStatus(...args) {
        return this.shellController.updateStatus(...args);
    }

    startClock(...args) {
        return this.shellController.startClock(...args);
    }

    startCountdown(...args) {
        return this.shellController.startCountdown(...args);
    }

    stopCountdown(...args) {
        return this.shellController.stopCountdown(...args);
    }

    resetCountdown(...args) {
        return this.shellController.resetCountdown(...args);
    }

    updateCountdownDisplay(...args) {
        return this.shellController.updateCountdownDisplay(...args);
    }

    get controlsController() {
        return this._controlsController ||= new CASControlsController(this);
    }

    setupEventListeners(...args) {
        return this.controlsController.setupEventListeners(...args);
    }

    onClick(...args) {
        return this.controlsController.onClick(...args);
    }

    togglePanicMute(...args) {
        return this.controlsController.togglePanicMute(...args);
    }

    setupDialogKeyboard(...args) {
        return this.controlsController.setupDialogKeyboard(...args);
    }

    handleHotkeys(...args) {
        return this.controlsController.handleHotkeys(...args);
    }

    handleVolumeWheel(...args) {
        return this.controlsController.handleVolumeWheel(...args);
    }

    initSettingsUI(...args) {
        return this.controlsController.initSettingsUI(...args);
    }

    syncSettingsUI(...args) {
        return this.controlsController.syncSettingsUI(...args);
    }

    get remoteController() {
        return this._remoteController ||= new CASRemoteController(this);
    }

    get remoteStateInterval() { return this.remoteController.remoteStateInterval; }
    set remoteStateInterval(value) { this.remoteController.remoteStateInterval = value; }

    get _lastRemoteTimeBroadcast() { return this.remoteController._lastRemoteTimeBroadcast; }
    set _lastRemoteTimeBroadcast(value) { this.remoteController._lastRemoteTimeBroadcast = value; }

    showRemoteControlDialog(...args) {
        return this.remoteController.showRemoteControlDialog(...args);
    }

    refreshRemoteControlStatus(...args) {
        return this.remoteController.refreshRemoteControlStatus(...args);
    }

    updateRemoteDialogUI(...args) {
        return this.remoteController.updateRemoteDialogUI(...args);
    }

    setupRemoteControlDialog(...args) {
        return this.remoteController.setupRemoteControlDialog(...args);
    }

    initRemoteControl(...args) {
        return this.remoteController.initRemoteControl(...args);
    }

    getRemoteStateSnapshot(...args) {
        return this.remoteController.getRemoteStateSnapshot(...args);
    }

    broadcastRemoteState(...args) {
        return this.remoteController.broadcastRemoteState(...args);
    }

    get libraryController() {
        return this._libraryController ||= new CASLibraryController(this);
    }

    get playlistRequestId() { return this.libraryController.playlistRequestId; }
    set playlistRequestId(value) { this.libraryController.playlistRequestId = value; }

    get refreshRequestId() { return this.libraryController.refreshRequestId; }
    set refreshRequestId(value) { this.libraryController.refreshRequestId = value; }

    get durationLoadQueue() { return this.libraryController.durationLoadQueue; }
    set durationLoadQueue(value) { this.libraryController.durationLoadQueue = value; }

    get metadataLoadQueue() { return this.libraryController.metadataLoadQueue; }
    set metadataLoadQueue(value) { this.libraryController.metadataLoadQueue = value; }

    get activeDurationLoads() { return this.libraryController.activeDurationLoads; }
    set activeDurationLoads(value) { this.libraryController.activeDurationLoads = value; }

    get activeMetadataLoads() { return this.libraryController.activeMetadataLoads; }
    set activeMetadataLoads(value) { this.libraryController.activeMetadataLoads = value; }

    get maxDurationLoads() { return this.libraryController.maxDurationLoads; }
    set maxDurationLoads(value) { this.libraryController.maxDurationLoads = value; }

    get maxMetadataLoads() { return this.libraryController.maxMetadataLoads; }
    set maxMetadataLoads(value) { this.libraryController.maxMetadataLoads = value; }

    get trackDurationTasks() { return this.libraryController.trackDurationTasks; }
    set trackDurationTasks(value) { this.libraryController.trackDurationTasks = value; }

    get trackMetadataTasks() { return this.libraryController.trackMetadataTasks; }
    set trackMetadataTasks(value) { this.libraryController.trackMetadataTasks = value; }

    get trackLoadGeneration() { return this.libraryController.trackLoadGeneration; }
    set trackLoadGeneration(value) { this.libraryController.trackLoadGeneration = value; }

    toSafeAudioSource(...args) {
        return this.libraryController.toSafeAudioSource(...args);
    }

    getAudioFormat(...args) {
        return this.libraryController.getAudioFormat(...args);
    }

    getTrackTitle(...args) {
        return this.libraryController.getTrackTitle(...args);
    }

    getTrackArtist(...args) {
        return this.libraryController.getTrackArtist(...args);
    }

    getTrackDisplayNumber(...args) {
        return this.libraryController.getTrackDisplayNumber(...args);
    }

    getTrackDisplayName(...args) {
        return this.libraryController.getTrackDisplayName(...args);
    }

    getTrackStartOffset(...args) {
        return this.libraryController.getTrackStartOffset(...args);
    }

    formatTrackStartOffset(...args) {
        return this.libraryController.formatTrackStartOffset(...args);
    }

    parseTrackStartOffset(...args) {
        return this.libraryController.parseTrackStartOffset(...args);
    }

    isTrackMetadataOverridden(...args) {
        return this.libraryController.isTrackMetadataOverridden(...args);
    }

    changeMusicFolder(...args) {
        return this.libraryController.changeMusicFolder(...args);
    }

    refreshPlaylists(...args) {
        return this.libraryController.refreshPlaylists(...args);
    }

    displayNoPlaylists(...args) {
        return this.libraryController.displayNoPlaylists(...args);
    }

    displayPlaylistError(...args) {
        return this.libraryController.displayPlaylistError(...args);
    }

    displayPlaylists(...args) {
        return this.libraryController.displayPlaylists(...args);
    }

    loadPlaylist(...args) {
        return this.libraryController.loadPlaylist(...args);
    }

    openMusicFolder(...args) {
        return this.libraryController.openMusicFolder(...args);
    }

    updatePlaylistSelection(...args) {
        return this.libraryController.updatePlaylistSelection(...args);
    }

    resetPlaylistState(...args) {
        return this.libraryController.resetPlaylistState(...args);
    }

    renderTrackArtist(...args) {
        return this.libraryController.renderTrackArtist(...args);
    }

    renderTrackStartBadge(...args) {
        return this.libraryController.renderTrackStartBadge(...args);
    }

    updateTrackRowDetails(...args) {
        return this.libraryController.updateTrackRowDetails(...args);
    }

    enqueueDurationLoad(...args) {
        return this.libraryController.enqueueDurationLoad(...args);
    }

    processDurationLoadQueue(...args) {
        return this.libraryController.processDurationLoadQueue(...args);
    }

    readTrackDuration(...args) {
        return this.libraryController.readTrackDuration(...args);
    }

    loadTrackDuration(...args) {
        return this.libraryController.loadTrackDuration(...args);
    }

    enqueueMetadataLoad(...args) {
        return this.libraryController.enqueueMetadataLoad(...args);
    }

    processMetadataLoadQueue(...args) {
        return this.libraryController.processMetadataLoadQueue(...args);
    }

    applyTrackMetadata(...args) {
        return this.libraryController.applyTrackMetadata(...args);
    }

    loadTrackMetadata(...args) {
        return this.libraryController.loadTrackMetadata(...args);
    }

    openTrackMetadataEditor(...args) {
        return this.libraryController.openTrackMetadataEditor(...args);
    }

    saveTrackMetadata(...args) {
        return this.libraryController.saveTrackMetadata(...args);
    }

    clearTrackMetadata(...args) {
        return this.libraryController.clearTrackMetadata(...args);
    }

    updateCurrentTrackDisplay(...args) {
        return this.libraryController.updateCurrentTrackDisplay(...args);
    }

    formatTime(...args) {
        return this.libraryController.formatTime(...args);
    }

    get decksController() {
        return this._decksController ||= new CASDecksController(this);
    }

    get deckManager() { return this.decksController.deckManager; }
    set deckManager(value) { this.decksController.deckManager = value; }

    get decks() { return this.decksController.decks; }
    set decks(value) { this.decksController.decks = value; }

    displayTracks(...args) {
        return this.decksController.displayTracks(...args);
    }

    handleTrackDragStart(...args) {
        return this.decksController.handleTrackDragStart(...args);
    }

    handleTrackDragOver(...args) {
        return this.decksController.handleTrackDragOver(...args);
    }

    handleTrackDragEnter(...args) {
        return this.decksController.handleTrackDragEnter(...args);
    }

    handleTrackDragLeave(...args) {
        return this.decksController.handleTrackDragLeave(...args);
    }

    handleContainerDragOver(...args) {
        return this.decksController.handleContainerDragOver(...args);
    }

    handleContainerDragLeave(...args) {
        return this.decksController.handleContainerDragLeave(...args);
    }

    handleContainerDrop(...args) {
        return this.decksController.handleContainerDrop(...args);
    }

    handleTrackDrop(...args) {
        return this.decksController.handleTrackDrop(...args);
    }

    handleTrackDragEnd(...args) {
        return this.decksController.handleTrackDragEnd(...args);
    }

    moveTrackBetweenDecks(...args) {
        return this.decksController.moveTrackBetweenDecks(...args);
    }

    playTrackInDeck(...args) {
        return this.decksController.playTrackInDeck(...args);
    }

    playTrack(...args) {
        return this.decksController.playTrack(...args);
    }

    captureOnlineTarget(...args) {
        return this.decksController.captureOnlineTarget(...args);
    }

    insertOnlineTrack(...args) {
        return this.decksController.insertOnlineTrack(...args);
    }

    filterTracksInDeck(...args) {
        return this.decksController.filterTracksInDeck(...args);
    }

    filterTracks(...args) {
        return this.decksController.filterTracks(...args);
    }

    setActiveDeck(...args) {
        return this.decksController.setActiveDeck(...args);
    }

    setViewMode(...args) {
        return this.decksController.setViewMode(...args);
    }

    updateDeckUI(...args) {
        return this.decksController.updateDeckUI(...args);
    }

    highlightCurrentTrack(...args) {
        return this.decksController.highlightCurrentTrack(...args);
    }

    updateTrackCounter(...args) {
        return this.decksController.updateTrackCounter(...args);
    }

    get playbackController() {
        return this._playbackController ||= new CASPlaybackController(this);
    }

    get musicPlayer() { return this.playbackController.musicPlayer; }
    set musicPlayer(value) { this.playbackController.musicPlayer = value; }

    get musicPlayerDeck() { return this.playbackController.musicPlayerDeck; }
    set musicPlayerDeck(value) { this.playbackController.musicPlayerDeck = value; }

    get musicPlayerTrack() { return this.playbackController.musicPlayerTrack; }
    set musicPlayerTrack(value) { this.playbackController.musicPlayerTrack = value; }

    get isPlaying() { return this.playbackController.isPlaying; }
    set isPlaying(value) { this.playbackController.isPlaying = value; }

    get isPaused() { return this.playbackController.isPaused; }
    set isPaused(value) { this.playbackController.isPaused = value; }

    get isMuted() { return this.playbackController.isMuted; }
    set isMuted(value) { this.playbackController.isMuted = value; }

    get musicPlayerToken() { return this.playbackController.musicPlayerToken; }
    set musicPlayerToken(value) { this.playbackController.musicPlayerToken = value; }

    get pendingMusicStart() { return this.playbackController.pendingMusicStart; }
    set pendingMusicStart(value) { this.playbackController.pendingMusicStart = value; }

    get musicRetryTimeout() { return this.playbackController.musicRetryTimeout; }
    set musicRetryTimeout(value) { this.playbackController.musicRetryTimeout = value; }

    get consecutivePlayErrors() { return this.playbackController.consecutivePlayErrors; }
    set consecutivePlayErrors(value) { this.playbackController.consecutivePlayErrors = value; }

    get playbackMode() { return this.playbackController.playbackMode; }
    set playbackMode(value) { this.playbackController.playbackMode = value; }

    get musicVolume() { return this.playbackController.musicVolume; }
    set musicVolume(value) { this.playbackController.musicVolume = value; }

    get musicVolumeTimeout() { return this.playbackController.musicVolumeTimeout; }
    set musicVolumeTimeout(value) { this.playbackController.musicVolumeTimeout = value; }

    get volumeUpdateTimeout() { return this.playbackController.volumeUpdateTimeout; }
    set volumeUpdateTimeout(value) { this.playbackController.volumeUpdateTimeout = value; }

    get progressAnimationFrame() { return this.playbackController.progressAnimationFrame; }
    set progressAnimationFrame(value) { this.playbackController.progressAnimationFrame = value; }

    get lastTimeUpdate() { return this.playbackController.lastTimeUpdate; }
    set lastTimeUpdate(value) { this.playbackController.lastTimeUpdate = value; }

    get _cachedTimeDisplays() { return this.playbackController._cachedTimeDisplays; }
    set _cachedTimeDisplays(value) { this.playbackController._cachedTimeDisplays = value; }

    get lastRulerDuration() { return this.playbackController.lastRulerDuration; }
    set lastRulerDuration(value) { this.playbackController.lastRulerDuration = value; }

    get onlinePlayIntent() { return this.playbackController.onlinePlayIntent; }
    set onlinePlayIntent(value) { this.playbackController.onlinePlayIntent = value; }

    loadTrack(...args) {
        return this.playbackController.loadTrack(...args);
    }

    handleTrackEnd(...args) {
        return this.playbackController.handleTrackEnd(...args);
    }

    playMusic(...args) {
        return this.playbackController.playMusic(...args);
    }

    pauseMusic(...args) {
        return this.playbackController.pauseMusic(...args);
    }

    stopMusic(...args) {
        return this.playbackController.stopMusic(...args);
    }

    previousTrack(...args) {
        return this.playbackController.previousTrack(...args);
    }

    nextTrack(...args) {
        return this.playbackController.nextTrack(...args);
    }

    _navigateTrack(...args) {
        return this.playbackController._navigateTrack(...args);
    }

    startProgressTracking(...args) {
        return this.playbackController.startProgressTracking(...args);
    }

    clearRemainingTimeWarning(...args) {
        return this.playbackController.clearRemainingTimeWarning(...args);
    }

    updateTimeDisplays(...args) {
        return this.playbackController.updateTimeDisplays(...args);
    }

    stopProgressTracking(...args) {
        return this.playbackController.stopProgressTracking(...args);
    }

    seekMusic(...args) {
        return this.playbackController.seekMusic(...args);
    }

    setMusicVolume(...args) {
        return this.playbackController.setMusicVolume(...args);
    }

    getPlaybackModeName(...args) {
        return this.playbackController.getPlaybackModeName(...args);
    }

    setupMediaSession(...args) {
        return this.playbackController.setupMediaSession(...args);
    }

    updateMediaSessionMetadata(...args) {
        return this.playbackController.updateMediaSessionMetadata(...args);
    }

    get crossfadeController() {
        return this._crossfadeController ||= new CASCrossfadeController(this);
    }

    get retiringMusicPlayers() { return this.crossfadeController.retiringMusicPlayers; }
    set retiringMusicPlayers(value) { this.crossfadeController.retiringMusicPlayers = value; }

    get retiringMusicDeadlines() { return this.crossfadeController.retiringMusicDeadlines; }
    set retiringMusicDeadlines(value) { this.crossfadeController.retiringMusicDeadlines = value; }

    get crossfadeTimers() { return this.crossfadeController.crossfadeTimers; }
    set crossfadeTimers(value) { this.crossfadeController.crossfadeTimers = value; }

    get isCrossfading() { return this.crossfadeController.isCrossfading; }
    set isCrossfading(value) { this.crossfadeController.isCrossfading = value; }

    get crossfadeEnabled() { return this.crossfadeController.crossfadeEnabled; }
    set crossfadeEnabled(value) { this.crossfadeController.crossfadeEnabled = value; }

    get deckCrossfadeEnabled() { return this.crossfadeController.deckCrossfadeEnabled; }
    set deckCrossfadeEnabled(value) { this.crossfadeController.deckCrossfadeEnabled = value; }

    get crossfadeDuration() { return this.crossfadeController.crossfadeDuration; }
    set crossfadeDuration(value) { this.crossfadeController.crossfadeDuration = value; }

    get crossfadeOutgoingDeck() { return this.crossfadeController.crossfadeOutgoingDeck; }
    set crossfadeOutgoingDeck(value) { this.crossfadeController.crossfadeOutgoingDeck = value; }

    get automaticCrossfadeBlockedPlayer() { return this.crossfadeController.automaticCrossfadeBlockedPlayer; }
    set automaticCrossfadeBlockedPlayer(value) { this.crossfadeController.automaticCrossfadeBlockedPlayer = value; }

    get backgroundCrossfadeInterval() { return this.crossfadeController.backgroundCrossfadeInterval; }
    set backgroundCrossfadeInterval(value) { this.crossfadeController.backgroundCrossfadeInterval = value; }

    startBackgroundCrossfadeTracking(...args) {
        return this.crossfadeController.startBackgroundCrossfadeTracking(...args);
    }

    stopBackgroundCrossfadeTracking(...args) {
        return this.crossfadeController.stopBackgroundCrossfadeTracking(...args);
    }

    checkCrossfadeTick(...args) {
        return this.crossfadeController.checkCrossfadeTick(...args);
    }

    normalizeCrossfadeDuration(...args) {
        return this.crossfadeController.normalizeCrossfadeDuration(...args);
    }

    updateCrossfadeControls(...args) {
        return this.crossfadeController.updateCrossfadeControls(...args);
    }

    shouldCrossfadeTo(...args) {
        return this.crossfadeController.shouldCrossfadeTo(...args);
    }

    getCrossfadeDurationMs(...args) {
        return this.crossfadeController.getCrossfadeDurationMs(...args);
    }

    startCrossfadeTo(...args) {
        return this.crossfadeController.startCrossfadeTo(...args);
    }

    startCrossfadeToIndex(...args) {
        return this.crossfadeController.startCrossfadeToIndex(...args);
    }

    fadeOutAndUnloadMusicPlayer(...args) {
        return this.crossfadeController.fadeOutAndUnloadMusicPlayer(...args);
    }

    maybeStartAutomaticCrossfade(...args) {
        return this.crossfadeController.maybeStartAutomaticCrossfade(...args);
    }

    get waveformController() {
        return this._waveformController ||= new CASWaveformController(this);
    }

    get waveformCache() { return this.waveformController.waveformCache; }
    set waveformCache(value) { this.waveformController.waveformCache = value; }

    get waveformRequestId() { return this.waveformController.waveformRequestId; }
    set waveformRequestId(value) { this.waveformController.waveformRequestId = value; }

    get waveformPeaks() { return this.waveformController.waveformPeaks; }
    set waveformPeaks(value) { this.waveformController.waveformPeaks = value; }

    get currentWaveformTrack() { return this.waveformController.currentWaveformTrack; }
    set currentWaveformTrack(value) { this.waveformController.currentWaveformTrack = value; }

    get waveformResizeObserver() { return this.waveformController.waveformResizeObserver; }
    set waveformResizeObserver(value) { this.waveformController.waveformResizeObserver = value; }

    get waveformLoadTask() { return this.waveformController.waveformLoadTask; }
    set waveformLoadTask(value) { this.waveformController.waveformLoadTask = value; }

    setupWaveformCanvas(...args) {
        return this.waveformController.setupWaveformCanvas(...args);
    }

    setWaveformState(...args) {
        return this.waveformController.setWaveformState(...args);
    }

    clearWaveform(...args) {
        return this.waveformController.clearWaveform(...args);
    }

    loadWaveformForTrack(...args) {
        return this.waveformController.loadWaveformForTrack(...args);
    }

    toArrayBuffer(...args) {
        return this.waveformController.toArrayBuffer(...args);
    }

    getWaveformAudioContext(...args) {
        return this.waveformController.getWaveformAudioContext(...args);
    }

    createWaveformPeaks(...args) {
        return this.waveformController.createWaveformPeaks(...args);
    }

    getWaveformPeaksForWidth(...args) {
        return this.waveformController.getWaveformPeaksForWidth(...args);
    }

    drawWaveform(...args) {
        return this.waveformController.drawWaveform(...args);
    }

    updateWaveformProgress(...args) {
        return this.waveformController.updateWaveformProgress(...args);
    }

    seekFromWaveform(...args) {
        return this.waveformController.seekFromWaveform(...args);
    }

    get padsController() {
        return this._padsController ||= new CASPadsController(this);
    }

    get soundEffects() { return this.padsController.soundEffects; }
    set soundEffects(value) { this.padsController.soundEffects = value; }

    get selectedPad() { return this.padsController.selectedPad; }
    set selectedPad(value) { this.padsController.selectedPad = value; }

    get padProgressIntervals() { return this.padsController.padProgressIntervals; }
    set padProgressIntervals(value) { this.padsController.padProgressIntervals = value; }

    get padActiveSoundIds() { return this.padsController.padActiveSoundIds; }
    set padActiveSoundIds(value) { this.padsController.padActiveSoundIds = value; }

    get effectGenerations() { return this.padsController.effectGenerations; }
    set effectGenerations(value) { this.padsController.effectGenerations = value; }

    get padLabels() { return this.padsController.padLabels; }
    set padLabels(value) { this.padsController.padLabels = value; }

    get effectsVolume() { return this.padsController.effectsVolume; }
    set effectsVolume(value) { this.padsController.effectsVolume = value; }

    get effectsVolumeTimeout() { return this.padsController.effectsVolumeTimeout; }
    set effectsVolumeTimeout(value) { this.padsController.effectsVolumeTimeout = value; }

    selectPad(...args) {
        return this.padsController.selectPad(...args);
    }

    getPadLabel(...args) {
        return this.padsController.getPadLabel(...args);
    }

    getPadDisplayName(...args) {
        return this.padsController.getPadDisplayName(...args);
    }

    updatePadLabel(...args) {
        return this.padsController.updatePadLabel(...args);
    }

    nextEffectGeneration(...args) {
        return this.padsController.nextEffectGeneration(...args);
    }

    isCurrentEffectData(...args) {
        return this.padsController.isCurrentEffectData(...args);
    }

    getActivePadSoundIds(...args) {
        return this.padsController.getActivePadSoundIds(...args);
    }

    disposeEffectData(...args) {
        return this.padsController.disposeEffectData(...args);
    }

    assignSoundToPad(...args) {
        return this.padsController.assignSoundToPad(...args);
    }

    assignSound(...args) {
        return this.padsController.assignSound(...args);
    }

    renameSelectedPad(...args) {
        return this.padsController.renameSelectedPad(...args);
    }

    playSoundEffect(...args) {
        return this.padsController.playSoundEffect(...args);
    }

    playLoadedEffect(...args) {
        return this.padsController.playLoadedEffect(...args);
    }

    finishPadSound(...args) {
        return this.padsController.finishPadSound(...args);
    }

    startPadProgress(...args) {
        return this.padsController.startPadProgress(...args);
    }

    stopPadProgress(...args) {
        return this.padsController.stopPadProgress(...args);
    }

    animatePadPress(...args) {
        return this.padsController.animatePadPress(...args);
    }

    clearSelectedPad(...args) {
        return this.padsController.clearSelectedPad(...args);
    }

    stopAllEffects(...args) {
        return this.padsController.stopAllEffects(...args);
    }

    setEffectsVolume(...args) {
        return this.padsController.setEffectsVolume(...args);
    }

    createSoundPads(...args) {
        return this.padsController.createSoundPads(...args);
    }

    get storageController() {
        return this._storageController ||= new CASStorageController(this);
    }

    get _saveStoredDataTimeout() { return this.storageController._saveStoredDataTimeout; }
    set _saveStoredDataTimeout(value) { this.storageController._saveStoredDataTimeout = value; }

    get restoringStoredData() { return this.storageController.restoringStoredData; }
    set restoringStoredData(value) { this.storageController.restoringStoredData = value; }

    saveStoredData(...args) {
        return this.storageController.saveStoredData(...args);
    }

    saveStoredDataImmediate(...args) {
        return this.storageController.saveStoredDataImmediate(...args);
    }

    _writeStoredData(...args) {
        return this.storageController._writeStoredData(...args);
    }

    loadStoredData(...args) {
        return this.storageController.loadStoredData(...args);
    }
}

    return { CAS_CONFIG, CAS_LOGGER, CASDeckManager, CASPeakMeter, TheatreSoundMixer };
});
