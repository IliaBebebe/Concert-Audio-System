const test = require('node:test');
const assert = require('node:assert/strict');
const { CASDeckManager } = require('../renderer.js');

test('CASDeckManager: reordering track when moving forward and backward', () => {
    const dm = new CASDeckManager();
    const deck = dm.getDeck('A');
    deck.tracks = [
        { id: 't0', title: 'Track 0' },
        { id: 't1', title: 'Track 1' },
        { id: 't2', title: 'Track 2' },
        { id: 't3', title: 'Track 3' }
    ];
    deck.currentTrackIndex = 0;

    // Moving t0 to after t2 (insert after index 2)
    // Array becomes: t1, t2, t0, t3
    // Since currentTrackIndex was 0 (t0), it should follow t0 to index 2
    const res1 = dm.reorderTrack('A', 0, 2, true);
    assert.ok(res1);
    assert.deepStrictEqual(deck.tracks.map(t => t.id), ['t1', 't2', 't0', 't3']);
    assert.strictEqual(deck.currentTrackIndex, 2);

    // Moving t3 to before t1 (insert before index 0)
    // Array becomes: t3, t1, t2, t0
    // Current track t0 was at index 2, now shifted to index 3
    const res2 = dm.reorderTrack('A', 3, 0, false);
    assert.ok(res2);
    assert.deepStrictEqual(deck.tracks.map(t => t.id), ['t3', 't1', 't2', 't0']);
    assert.strictEqual(deck.currentTrackIndex, 3);
});

test('CASDeckManager: moving non-playing track updates currentTrackIndex correctly', () => {
    const dm = new CASDeckManager();
    const deck = dm.getDeck('A');
    deck.tracks = [
        { id: 't0', title: 'Track 0' },
        { id: 't1', title: 'Track 1' },
        { id: 't2', title: 'Track 2' },
        { id: 't3', title: 'Track 3' }
    ];
    deck.currentTrackIndex = 2; // currently playing t2

    // Move t0 (before current) to position after t3 (after current)
    // Current track t2 shifts down from index 2 to index 1
    dm.reorderTrack('A', 0, 3, true);
    assert.deepStrictEqual(deck.tracks.map(t => t.id), ['t1', 't2', 't3', 't0']);
    assert.strictEqual(deck.currentTrackIndex, 1);
    assert.strictEqual(deck.tracks[deck.currentTrackIndex].id, 't2');

    // Move t0 (now at index 3) back to before index 0
    // Current track t2 shifts up from index 1 to index 2
    dm.reorderTrack('A', 3, 0, false);
    assert.deepStrictEqual(deck.tracks.map(t => t.id), ['t0', 't1', 't2', 't3']);
    assert.strictEqual(deck.currentTrackIndex, 2);
    assert.strictEqual(deck.tracks[deck.currentTrackIndex].id, 't2');
});

test('CASDeckManager: handles invalid indices gracefully', () => {
    const dm = new CASDeckManager();
    const deck = dm.getDeck('A');
    deck.tracks = [{ id: 't0' }, { id: 't1' }];

    // Invalid fromIndex
    assert.strictEqual(dm.reorderTrack('A', -1, 1, false), null);
    assert.strictEqual(dm.reorderTrack('A', 5, 1, false), null);

    // Invalid toIndex
    assert.strictEqual(dm.reorderTrack('A', 0, -2, false), null);
    assert.strictEqual(dm.reorderTrack('A', 0, 10, false), null);

    // Invalid deck
    assert.strictEqual(dm.reorderTrack('C', 0, 1, false), null);

    // No-op move to same slot
    const noOpRes = dm.reorderTrack('A', 0, 0, false);
    assert.ok(noOpRes);
    assert.strictEqual(deck.tracks.length, 2);
});

test('CASDeckManager: dual deck isolation', () => {
    const dm = new CASDeckManager();
    const deckA = dm.getDeck('A');
    const deckB = dm.getDeck('B');

    deckA.tracks = [{ id: 'a0' }, { id: 'a1' }];
    deckB.tracks = [{ id: 'b0' }, { id: 'b1' }, { id: 'b2' }];

    deckA.currentTrackIndex = 1;
    deckB.currentTrackIndex = 0;

    dm.reorderTrack('A', 1, 0, false);
    assert.strictEqual(deckA.tracks[0].id, 'a1');
    assert.strictEqual(deckA.currentTrackIndex, 0);

    // Deck B must remain completely unaffected
    assert.strictEqual(deckB.tracks[0].id, 'b0');
    assert.strictEqual(deckB.tracks.length, 3);
    assert.strictEqual(deckB.currentTrackIndex, 0);
});

test('CASDeckManager: moveTrackBetweenDecks moves track from Deck A to Deck B with position and index tracking', () => {
    const dm = new CASDeckManager();
    const deckA = dm.getDeck('A');
    const deckB = dm.getDeck('B');

    deckA.tracks = [
        { id: 'a0', title: 'Track A0' },
        { id: 'a1', title: 'Track A1' },
        { id: 'a2', title: 'Track A2' }
    ];
    deckB.tracks = [
        { id: 'b0', title: 'Track B0' },
        { id: 'b1', title: 'Track B1' }
    ];

    deckA.currentTrackIndex = 1; // pointing to a1
    deckB.currentTrackIndex = 1; // pointing to b1

    // Move a0 to Deck B before b1 (targetIndex = 1, insertAfter = false -> insertAt = 1)
    const res1 = dm.moveTrackBetweenDecks('A', 0, 'B', 1, false);
    assert.ok(res1);
    assert.strictEqual(res1.movedTrack.id, 'a0');
    assert.strictEqual(res1.insertAt, 1);
    assert.deepStrictEqual(deckA.tracks.map(t => t.id), ['a1', 'a2']);
    assert.deepStrictEqual(deckB.tracks.map(t => t.id), ['b0', 'a0', 'b1']);

    // In deckA: moved track was at 0 (< currentTrackIndex 1), so currentTrackIndex decrements to 0 (a1)
    assert.strictEqual(deckA.currentTrackIndex, 0);
    assert.strictEqual(deckA.tracks[deckA.currentTrackIndex].id, 'a1');

    // In deckB: inserted at 1 (<= currentTrackIndex 1), so currentTrackIndex increments to 2 (b1)
    assert.strictEqual(deckB.currentTrackIndex, 2);
    assert.strictEqual(deckB.tracks[deckB.currentTrackIndex].id, 'b1');
});

test('CASDeckManager: moveTrackBetweenDecks moves track to empty deck and appends to end', () => {
    const dm = new CASDeckManager();
    const deckA = dm.getDeck('A');
    const deckB = dm.getDeck('B');

    deckA.tracks = [{ id: 'a0' }, { id: 'a1' }];
    deckB.tracks = [];
    deckA.currentTrackIndex = 0;
    deckB.currentTrackIndex = 0;

    // Move a0 into empty Deck B with targetIndex = null
    const res = dm.moveTrackBetweenDecks('A', 0, 'B', null, true);
    assert.ok(res);
    assert.strictEqual(res.insertAt, 0);
    assert.deepStrictEqual(deckB.tracks.map(t => t.id), ['a0']);
    assert.strictEqual(deckB.currentTrackIndex, 0);
    assert.deepStrictEqual(deckA.tracks.map(t => t.id), ['a1']);
    assert.strictEqual(deckA.currentTrackIndex, 0);

    // Move a1 into Deck B appending to end
    const res2 = dm.moveTrackBetweenDecks('A', 0, 'B', null, true);
    assert.ok(res2);
    assert.strictEqual(res2.insertAt, 1);
    assert.deepStrictEqual(deckB.tracks.map(t => t.id), ['a0', 'a1']);
    assert.deepStrictEqual(deckA.tracks, []);
    assert.strictEqual(deckA.currentTrackIndex, 0);
});

test('CASDeckManager: moveTrackBetweenDecks delegates to same-deck reorder', () => {
    const dm = new CASDeckManager();
    const deckA = dm.getDeck('A');
    deckA.tracks = [{ id: 't0' }, { id: 't1' }, { id: 't2' }];
    deckA.currentTrackIndex = 0;

    // Same deck move to end
    const res = dm.moveTrackBetweenDecks('A', 0, 'A', null, true);
    assert.ok(res);
    assert.strictEqual(res.isSameDeck, true);
    assert.deepStrictEqual(deckA.tracks.map(t => t.id), ['t1', 't2', 't0']);
    assert.strictEqual(deckA.currentTrackIndex, 2);
});

test('CASDeckManager: moveTrackBetweenDecks handles invalid arguments gracefully', () => {
    const dm = new CASDeckManager();
    const deckA = dm.getDeck('A');
    deckA.tracks = [{ id: 't0' }];

    assert.strictEqual(dm.moveTrackBetweenDecks('Invalid', 0, 'B', 0, false), null);
    assert.strictEqual(dm.moveTrackBetweenDecks('A', 0, 'Invalid', 0, false), null);
    assert.strictEqual(dm.moveTrackBetweenDecks('A', -1, 'B', 0, false), null);
    assert.strictEqual(dm.moveTrackBetweenDecks('A', 5, 'B', 0, false), null);
});
