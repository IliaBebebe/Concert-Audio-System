const test = require('node:test');
const assert = require('node:assert/strict');
const { CASDeckManager, TheatreSoundMixer } = require('../renderer.js');

function createMockMixer() {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.deckManager = new CASDeckManager();
    mixer.decks = mixer.deckManager.decks;
    mixer.crossfadeEnabled = true;
    mixer.deckCrossfadeEnabled = false;
    mixer.crossfadeDuration = 3;
    mixer.musicPlayer = { duration: () => 180, seek: () => 30 };
    mixer.musicPlayerToken = 1;
    mixer.isPlaying = true;
    mixer.isPaused = false;
    mixer.pendingMusicStart = false;
    mixer.isCrossfading = false;
    mixer.playbackMode = 'sequential';
    mixer.playingDeck = 'A';
    mixer.activeDeck = 'A';
    mixer.crossfadeTimers = new Set();
    mixer.retiringMusicPlayers = new Set();
    mixer.backgroundCrossfadeInterval = null;

    mixer.decks.A.tracks = [
        { id: 'a1', title: 'Deck A Track 1' },
        { id: 'a2', title: 'Deck A Track 2' },
        { id: 'a3', title: 'Deck A Track 3' }
    ];
    mixer.decks.A.currentTrackIndex = 0;

    mixer.decks.B.tracks = [
        { id: 'b1', title: 'Deck B Track 1' },
        { id: 'b2', title: 'Deck B Track 2' }
    ];
    mixer.decks.B.currentTrackIndex = 0;

    return mixer;
}

test('CASDeckManager: reset() returns both decks to initial empty state', () => {
    const dm = new CASDeckManager();
    dm.getDeck('A').tracks = [{ id: '1' }];
    dm.getDeck('A').currentTrackIndex = 2;
    dm.getDeck('B').tracks = [{ id: '2' }];
    dm.setActiveDeck('B');
    dm.setPlayingDeck('B');
    dm.viewMode = 'B';

    dm.reset();

    assert.strictEqual(dm.activeDeck, 'A');
    assert.strictEqual(dm.playingDeck, null);
    assert.strictEqual(dm.viewMode, 'split');
    assert.deepStrictEqual(dm.getDeck('A').tracks, []);
    assert.strictEqual(dm.getDeck('A').currentTrackIndex, 0);
    assert.deepStrictEqual(dm.getDeck('B').tracks, []);
    assert.strictEqual(dm.getDeck('B').currentTrackIndex, 0);
});

test('handleTrackEnd in sequential mode stops playback when reaching the end of playlist', () => {
    const mixer = createMockMixer();
    mixer.decks.A.currentTrackIndex = 2; // Last track of 3
    let stopCalled = false;
    let statusMessage = '';
    mixer.stopMusic = () => { stopCalled = true; };
    mixer.updateStatus = (msg) => { statusMessage = msg; };
    mixer.nextTrack = () => { assert.fail('nextTrack should not be called at the end of playlist'); };

    mixer.handleTrackEnd(mixer.musicPlayer, mixer.musicPlayerToken);

    assert.strictEqual(stopCalled, true);
    assert.strictEqual(statusMessage, 'Воспроизведение завершено');
});

test('handleTrackEnd in sequential mode advances to next track when not at the end', () => {
    const mixer = createMockMixer();
    mixer.decks.A.currentTrackIndex = 1; // Middle track
    let nextCalled = false;
    mixer.stopMusic = () => { assert.fail('stopMusic should not be called'); };
    mixer.nextTrack = () => { nextCalled = true; };

    mixer.handleTrackEnd(mixer.musicPlayer, mixer.musicPlayerToken);

    assert.strictEqual(nextCalled, true);
});

test('maybeStartAutomaticCrossfade does not crossfade at the last track of playlist', () => {
    const mixer = createMockMixer();
    mixer.decks.A.currentTrackIndex = 2; // Last track of 3
    let crossfadeStarted = false;
    mixer.startCrossfadeTo = () => { crossfadeStarted = true; };

    // Duration 180s, seek at 178s (remaining 2s <= 3s fade)
    mixer.maybeStartAutomaticCrossfade(mixer.musicPlayer, mixer.musicPlayerToken, 178, 180);

    assert.strictEqual(crossfadeStarted, false);
});

test('maybeStartAutomaticCrossfade starts crossfade when within fade window before last track', () => {
    const mixer = createMockMixer();
    mixer.decks.A.currentTrackIndex = 0; // First track
    let crossfadeTargetIndex = null;
    mixer.startCrossfadeTo = (deckId, targetIndex) => {
        crossfadeTargetIndex = targetIndex;
    };

    // Duration 180s, seek at 178s (remaining 2s <= 3s fade)
    mixer.maybeStartAutomaticCrossfade(mixer.musicPlayer, mixer.musicPlayerToken, 178, 180);

    assert.strictEqual(crossfadeTargetIndex, 1);
});

test('maybeStartAutomaticCrossfade skips short tracks (duration <= fadeSeconds * 1.5)', () => {
    const mixer = createMockMixer();
    mixer.decks.A.currentTrackIndex = 0;
    mixer.crossfadeDuration = 4; // fadeSeconds = 4, 4 * 1.5 = 6s threshold
    let crossfadeStarted = false;
    mixer.startCrossfadeTo = () => { crossfadeStarted = true; };

    // Short track: duration 5s <= 6s
    mixer.maybeStartAutomaticCrossfade(mixer.musicPlayer, mixer.musicPlayerToken, 4.5, 5);

    assert.strictEqual(crossfadeStarted, false);
});

test('startBackgroundCrossfadeTracking and stopBackgroundCrossfadeTracking manage interval cleanly', () => {
    const mixer = createMockMixer();
    assert.strictEqual(mixer.backgroundCrossfadeInterval, null);

    mixer.startBackgroundCrossfadeTracking();
    assert.ok(mixer.backgroundCrossfadeInterval);

    mixer.stopBackgroundCrossfadeTracking();
    assert.strictEqual(mixer.backgroundCrossfadeInterval, null);
});

test('handleTrackEnd in single mode stops playback', () => {
    const mixer = createMockMixer();
    mixer.playbackMode = 'single';
    let stopCalled = false;
    mixer.stopMusic = () => { stopCalled = true; };
    mixer.nextTrack = () => { assert.fail('nextTrack should not be called in single mode'); };

    mixer.handleTrackEnd(mixer.musicPlayer, mixer.musicPlayerToken);
    assert.strictEqual(stopCalled, true);
});

test('handleTrackEnd in loop mode does not stop or advance', () => {
    const mixer = createMockMixer();
    mixer.playbackMode = 'loop';
    mixer.stopMusic = () => { assert.fail('stopMusic should not be called in loop mode'); };
    mixer.nextTrack = () => { assert.fail('nextTrack should not be called in loop mode'); };

    mixer.handleTrackEnd(mixer.musicPlayer, mixer.musicPlayerToken);
});

test('toSafeAudioSource safely encodes special characters and preserves valid schemes', () => {
    const mixer = createMockMixer();

    // Windows path with hash and question mark
    const winPath = 'C:\\Music\\Track #1 & #2? [Live].mp3';
    assert.strictEqual(
        mixer.toSafeAudioSource(winPath),
        'file:///C:/Music/Track%20%231%20&%20%232%3F%20%5BLive%5D.mp3'
    );

    // Unix path
    const unixPath = '/home/user/music/My Song #3.flac';
    assert.strictEqual(
        mixer.toSafeAudioSource(unixPath),
        'file:///home/user/music/My%20Song%20%233.flac'
    );

    // Already file://, data:, or blob:
    assert.strictEqual(mixer.toSafeAudioSource('file:///test.mp3'), 'file:///test.mp3');
    assert.strictEqual(mixer.toSafeAudioSource('data:audio/wav;base64,123'), 'data:audio/wav;base64,123');
    assert.strictEqual(mixer.toSafeAudioSource('blob:http://localhost/abc'), 'blob:http://localhost/abc');
    assert.strictEqual(mixer.toSafeAudioSource(''), '');
    assert.strictEqual(mixer.toSafeAudioSource(null), '');
});

test('getAudioFormat extracts audio extension safely', () => {
    const mixer = createMockMixer();
    assert.deepStrictEqual(mixer.getAudioFormat('C:\\Music\\song.MP3'), ['mp3']);
    assert.deepStrictEqual(mixer.getAudioFormat('/path/to/track.flac?version=1'), ['flac']);
    assert.deepStrictEqual(mixer.getAudioFormat('test.wav#t=10'), ['wav']);
    assert.strictEqual(mixer.getAudioFormat(''), undefined);
    assert.strictEqual(mixer.getAudioFormat(null), undefined);
});

test('setActiveDeck refreshes cued track display and waveform when playback is stopped', () => {
    const mixer = createMockMixer();
    mixer.isPlaying = false;
    mixer.isPaused = false;
    mixer.playingDeck = null;
    let displayedTrack = null;
    let waveformTrack = null;
    mixer.updateCurrentTrackDisplay = (track) => { displayedTrack = track; };
    mixer.loadWaveformForTrack = (track) => { waveformTrack = track; };
    mixer.updateDeckUI = () => {};
    mixer.updatePlaylistSelection = () => {};
    mixer.updateTrackCounter = () => {};
    mixer.updateStatus = () => {};
    mixer.saveStoredData = () => {};

    mixer.setActiveDeck('B');

    assert.strictEqual(mixer.activeDeck, 'B');
    assert.strictEqual(displayedTrack, mixer.decks.B.tracks[0]);
    assert.strictEqual(waveformTrack, mixer.decks.B.tracks[0]);
});

test('playMusic loads and plays the active deck when starting from stopped state', () => {
    const mixer = createMockMixer();
    mixer.isPlaying = false;
    mixer.isPaused = false;
    mixer.playingDeck = null;
    mixer.activeDeck = 'B';
    let loadedDeckId = null;
    let playCalled = false;
    mixer.loadTrack = (index, opts) => {
        loadedDeckId = opts.deckId;
        mixer.musicPlayer = {
            playing: () => false,
            play: () => { playCalled = true; return 1; }
        };
    };
    mixer.resumeAudioContext = () => {};
    mixer.updateDeckUI = () => {};

    mixer.playMusic();

    assert.strictEqual(loadedDeckId, 'B');
    assert.strictEqual(playCalled, true);
});

test('applyTrackMetadata handles artist arrays and string formats correctly', () => {
    const mixer = createMockMixer();
    const track = { path: 'song.mp3', title: 'Song', artist: 'Unknown' };

    mixer.applyTrackMetadata(track, {
        success: true,
        data: {
            artist: ['First Artist', 'Second Artist'],
            title: 'Cool Song',
            trackNumber: 5
        }
    });

    assert.strictEqual(track.artist, 'First Artist, Second Artist');
    assert.strictEqual(track.title, 'Cool Song');
    assert.strictEqual(track.trackNumber, 5);
});

