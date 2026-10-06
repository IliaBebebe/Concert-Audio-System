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
