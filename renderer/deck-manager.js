(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
class CASDeckManager {
    constructor() {
        this.decks = {
            A: { playlist: null, tracks: [], currentTrackIndex: 0, filterQuery: '' },
            B: { playlist: null, tracks: [], currentTrackIndex: 0, filterQuery: '' }
        };
        this.activeDeck = 'A';
        this.playingDeck = null;
        this.viewMode = 'split';
        this.dragState = null;
    }

    getDeck(deckId) {
        return this.decks[deckId] || null;
    }

    getCurrentDeck() {
        const deckId = this.playingDeck || this.activeDeck;
        return this.decks[deckId] || this.decks.A;
    }

    setActiveDeck(deckId) {
        if (deckId === 'A' || deckId === 'B') {
            this.activeDeck = deckId;
            return true;
        }
        return false;
    }

    setPlayingDeck(deckId) {
        if (deckId === 'A' || deckId === 'B' || deckId === null) {
            this.playingDeck = deckId;
            return true;
        }
        return false;
    }

    reset() {
        this.decks.A = { playlist: null, tracks: [], currentTrackIndex: 0, filterQuery: '' };
        this.decks.B = { playlist: null, tracks: [], currentTrackIndex: 0, filterQuery: '' };
        this.activeDeck = 'A';
        this.playingDeck = null;
        this.viewMode = 'split';
        this.dragState = null;
    }

    setViewMode(mode) {
        if (['split', 'A', 'B'].includes(mode)) {
            this.viewMode = mode;
            if (mode === 'A' || mode === 'B') {
                this.activeDeck = mode;
            }
            return true;
        }
        return false;
    }

    reorderTrack(deckId, sourceIndex, targetIndex, insertAfter) {
        const deck = this.decks[deckId];
        if (!deck || !Array.isArray(deck.tracks)) return null;

        const tracks = deck.tracks;
        if (sourceIndex < 0 || sourceIndex >= tracks.length) return null;
        if (targetIndex < 0 || targetIndex >= tracks.length) return null;
        if (sourceIndex === targetIndex) return { tracks, newCurrentIndex: deck.currentTrackIndex, insertAt: targetIndex };

        const [movedTrack] = tracks.splice(sourceIndex, 1);
        let insertAt;
        if (insertAfter) {
            insertAt = sourceIndex < targetIndex ? targetIndex : targetIndex + 1;
        } else {
            insertAt = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        }

        tracks.splice(insertAt, 0, movedTrack);

        let newCurrentIndex = deck.currentTrackIndex;
        if (deck.currentTrackIndex === sourceIndex) {
            newCurrentIndex = insertAt;
        } else {
            if (deck.currentTrackIndex > sourceIndex) newCurrentIndex--;
            if (newCurrentIndex >= insertAt) newCurrentIndex++;
        }
        deck.currentTrackIndex = newCurrentIndex;

        return { tracks, newCurrentIndex, insertAt };
    }

    moveTrackBetweenDecks(sourceDeckId, sourceIndex, targetDeckId, targetIndex = null, insertAfter = false) {
        if (!this.decks[sourceDeckId] || !this.decks[targetDeckId]) return null;

        if (sourceDeckId === targetDeckId) {
            if (targetIndex === null || targetIndex === undefined) {
                const tracks = this.decks[sourceDeckId].tracks || [];
                if (tracks.length === 0) return null;
                targetIndex = tracks.length - 1;
                insertAfter = true;
            }
            const res = this.reorderTrack(sourceDeckId, sourceIndex, targetIndex, insertAfter);
            if (!res) return null;
            return {
                sourceDeckId,
                targetDeckId,
                movedTrack: res.tracks[res.insertAt],
                sourceTracks: res.tracks,
                targetTracks: res.tracks,
                sourceNewCurrentIndex: res.newCurrentIndex,
                targetNewCurrentIndex: res.newCurrentIndex,
                insertAt: res.insertAt,
                isSameDeck: true
            };
        }

        const sourceDeck = this.decks[sourceDeckId];
        const targetDeck = this.decks[targetDeckId];
        if (!Array.isArray(sourceDeck.tracks) || !Array.isArray(targetDeck.tracks)) return null;
        if (sourceIndex < 0 || sourceIndex >= sourceDeck.tracks.length) return null;

        const [movedTrack] = sourceDeck.tracks.splice(sourceIndex, 1);
        if (!movedTrack) return null;

        if (!targetDeck.playlist && sourceDeck.playlist) {
            targetDeck.playlist = { ...sourceDeck.playlist, name: `Очередь ${targetDeckId}` };
        } else if (!targetDeck.playlist) {
            targetDeck.playlist = { name: `Очередь ${targetDeckId}`, path: null };
        }

        let insertAt;
        if (targetIndex === null || targetIndex === undefined || targetIndex < 0 || targetIndex >= targetDeck.tracks.length) {
            insertAt = targetDeck.tracks.length;
        } else {
            insertAt = insertAfter ? targetIndex + 1 : targetIndex;
        }

        if (insertAt < 0) insertAt = 0;
        if (insertAt > targetDeck.tracks.length) insertAt = targetDeck.tracks.length;

        targetDeck.tracks.splice(insertAt, 0, movedTrack);
        sourceDeck.customQueue = true;
        targetDeck.customQueue = true;

        // Update source deck currentTrackIndex
        let sourceNewCurrentIndex = sourceDeck.currentTrackIndex;
        if (sourceDeck.tracks.length === 0) {
            sourceNewCurrentIndex = 0;
        } else if (sourceDeck.currentTrackIndex === sourceIndex) {
            if (sourceNewCurrentIndex >= sourceDeck.tracks.length) {
                sourceNewCurrentIndex = sourceDeck.tracks.length - 1;
            }
        } else if (sourceDeck.currentTrackIndex > sourceIndex) {
            sourceNewCurrentIndex--;
        }
        sourceDeck.currentTrackIndex = sourceNewCurrentIndex;

        // Update target deck currentTrackIndex
        let targetNewCurrentIndex = targetDeck.currentTrackIndex;
        if (targetDeck.tracks.length === 1) {
            targetNewCurrentIndex = 0;
        } else if (insertAt <= targetNewCurrentIndex) {
            targetNewCurrentIndex++;
        }
        targetDeck.currentTrackIndex = targetNewCurrentIndex;

        return {
            sourceDeckId,
            targetDeckId,
            movedTrack,
            sourceTracks: sourceDeck.tracks,
            targetTracks: targetDeck.tracks,
            sourceNewCurrentIndex,
            targetNewCurrentIndex,
            insertAt,
            isSameDeck: false
        };
    }
}

    return { CASDeckManager };
});
