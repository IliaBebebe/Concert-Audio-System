const test = require('node:test');
const assert = require('node:assert/strict');
const { CAS_CONFIG, CASDeckManager, TheatreSoundMixer } = require('../renderer.js');

test('CAS_CONFIG is frozen and has expected defaults', () => {
    assert.strictEqual(Object.isFrozen(CAS_CONFIG), true);
    assert.strictEqual(CAS_CONFIG.CROSSFADE.DEFAULT_DURATION, 3);
    assert.strictEqual(CAS_CONFIG.CROSSFADE.MIN_DURATION, 1);
    assert.strictEqual(CAS_CONFIG.CROSSFADE.MAX_DURATION, 10);
    assert.strictEqual(CAS_CONFIG.AUDIO.DEFAULT_MUSIC_VOLUME, 0.7);
    assert.strictEqual(CAS_CONFIG.STORAGE.THROTTLE_MS, 400);
});

test('CASDeckManager initializes dual decks and manages active/playing states', () => {
    const dm = new CASDeckManager();
    assert.strictEqual(dm.activeDeck, 'A');
    assert.strictEqual(dm.playingDeck, null);
    assert.strictEqual(dm.viewMode, 'split');
    assert.ok(dm.getDeck('A'));
    assert.ok(dm.getDeck('B'));

    dm.setActiveDeck('B');
    assert.strictEqual(dm.activeDeck, 'B');

    dm.setPlayingDeck('A');
    assert.strictEqual(dm.playingDeck, 'A');

    dm.setViewMode('A');
    assert.strictEqual(dm.viewMode, 'A');
    assert.strictEqual(dm.activeDeck, 'A');

    dm.setViewMode('split');
    assert.strictEqual(dm.viewMode, 'split');
});

test('CASDeckManager reorderTrack properly repositions tracks and updates currentIndex', () => {
    const dm = new CASDeckManager();
    const deckA = dm.getDeck('A');
    deckA.tracks = [
        { id: 'track-0', title: 'Intro' },
        { id: 'track-1', title: 'Song 1' },
        { id: 'track-2', title: 'Song 2' },
        { id: 'track-3', title: 'Outro' }
    ];
    deckA.currentTrackIndex = 1; // Song 1 is current

    // Move track-3 (Outro) to the top (before index 0)
    const result = dm.reorderTrack('A', 3, 0, false);
    assert.ok(result);
    assert.strictEqual(deckA.tracks[0].id, 'track-3');
    assert.strictEqual(deckA.tracks[1].id, 'track-0');
    assert.strictEqual(deckA.tracks[2].id, 'track-1');
    assert.strictEqual(deckA.tracks[3].id, 'track-2');
    // Current track index shifted from 1 to 2
    assert.strictEqual(deckA.currentTrackIndex, 2);
});

function createMockMixer() {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.deckManager = new CASDeckManager();
    mixer.decks = mixer.deckManager.decks;
    mixer.crossfadeEnabled = true;
    mixer.deckCrossfadeEnabled = false;
    mixer.crossfadeDuration = 3;
    mixer.musicPlayer = { duration: () => 180, seek: () => 30 };
    mixer.isPlaying = true;
    mixer.isPaused = false;
    mixer.pendingMusicStart = false;
    mixer.isCrossfading = false;
    mixer.playingDeck = 'A';
    mixer.activeDeck = 'A';

    mixer.decks.A.tracks = [
        { id: 'a1', title: 'Deck A Track 1' },
        { id: 'a2', title: 'Deck A Track 2' }
    ];
    mixer.decks.A.currentTrackIndex = 0;

    mixer.decks.B.tracks = [
        { id: 'b1', title: 'Deck B Track 1' },
        { id: 'b2', title: 'Deck B Track 2' }
    ];
    mixer.decks.B.currentTrackIndex = 0;

    return mixer;
}

test('shouldCrossfadeTo handles in-playlist vs between-decks crossfade independently', () => {
    const mixer = createMockMixer();

    // 1. Crossfade inside Deck A (crossfadeEnabled = true) -> TRUE
    assert.strictEqual(mixer.shouldCrossfadeTo('A', 1), true);

    // 2. Crossfade to exact same track (index 0) -> FALSE
    assert.strictEqual(mixer.shouldCrossfadeTo('A', 0), false);

    // 3. Crossfade across decks with deckCrossfadeEnabled = false -> FALSE
    assert.strictEqual(mixer.shouldCrossfadeTo('B', 0), false);

    // 4. Enable deckCrossfadeEnabled -> TRUE across decks
    mixer.deckCrossfadeEnabled = true;
    assert.strictEqual(mixer.shouldCrossfadeTo('B', 0), true);

    // 5. Disable in-playlist crossfade, keep deck crossfade -> in-playlist FALSE, between-decks TRUE
    mixer.crossfadeEnabled = false;
    assert.strictEqual(mixer.shouldCrossfadeTo('A', 1), false);
    assert.strictEqual(mixer.shouldCrossfadeTo('B', 0), true);

    // 6. Disable both -> FALSE everywhere
    mixer.deckCrossfadeEnabled = false;
    assert.strictEqual(mixer.shouldCrossfadeTo('A', 1), false);
    assert.strictEqual(mixer.shouldCrossfadeTo('B', 0), false);
});

test('shouldCrossfadeTo returns false when music is paused, stopped, or duration is zero', () => {
    const mixer = createMockMixer();

    // Paused
    mixer.isPaused = true;
    assert.strictEqual(mixer.shouldCrossfadeTo('A', 1), false);
    mixer.isPaused = false;

    // Stopped
    mixer.isPlaying = false;
    assert.strictEqual(mixer.shouldCrossfadeTo('A', 1), false);
    mixer.isPlaying = true;

    // Duration is 0
    mixer.crossfadeDuration = 0;
    assert.strictEqual(mixer.shouldCrossfadeTo('A', 1), false);
    mixer.crossfadeDuration = 3;

    // Already crossfading
    mixer.isCrossfading = true;
    assert.strictEqual(mixer.shouldCrossfadeTo('A', 1), false);
});

test('playMusic with force: true starts new player even if isPlaying is true', () => {
    const mixer = createMockMixer();
    let playCallCount = 0;
    mixer.musicPlayer = {
        playing: () => false,
        play: () => {
            playCallCount++;
            return 1;
        }
    };
    mixer.isPlaying = true;
    mixer.isPaused = false;
    mixer.resumeAudioContext = () => {};
    mixer.updateDeckUI = () => {};

    // Normal playMusic when player is not playing but isPlaying flag is true
    // Because isPlayerActuallyPlaying is false, it plays!
    mixer.playMusic();
    assert.strictEqual(playCallCount, 1);

    // Calling playMusic with force: true also plays
    mixer.playMusic({ force: true });
    assert.strictEqual(playCallCount, 2);
});

test('pauseMusic cleans up retiring crossfade players immediately', () => {
    const mixer = createMockMixer();
    let outgoingStopped = false;
    let outgoingUnloaded = false;
    const retiringPlayer = {
        stop: () => { outgoingStopped = true; },
        unload: () => { outgoingUnloaded = true; }
    };
    mixer.retiringMusicPlayers = new Set([retiringPlayer]);
    mixer.crossfadeTimers = new Set([setTimeout(() => {}, 10000)]);
    mixer.isCrossfading = true;
    mixer.musicPlayer = { pause: () => {} };
    mixer.updateDeckUI = () => {};

    mixer.pauseMusic();

    assert.strictEqual(outgoingStopped, true);
    assert.strictEqual(outgoingUnloaded, true);
    assert.strictEqual(mixer.retiringMusicPlayers.size, 0);
    assert.strictEqual(mixer.crossfadeTimers.size, 0);
    assert.strictEqual(mixer.isCrossfading, false);
});

