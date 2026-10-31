const test = require('node:test');
const assert = require('node:assert/strict');
const { CASWorkspaceLayout } = require('../workspaces');
const keys = ['playlists', 'soundPads', 'tracks', 'nowPlaying', 'volume', 'countdown', 'hotkeys'];

test('workspace recovery assigns every known block once and rejects corrupt tab identifiers', () => {
    const layout = new CASWorkspaceLayout(keys, { version: 1, activeTab: 'missing', tabs: [
        { id: 'tab-show', title: 'Сцена', blocks: ['volume', 'volume', 'logo', 'tracks'] },
        { id: 'main', blocks: ['tracks', 'nowPlaying'] },
        { id: 'tab-show', blocks: ['soundPads'] },
        { id: '__proto__', blocks: ['countdown'] },
        null
    ] });
    assert.equal(layout.activeTab, 'main');
    assert.equal(layout.owner('tracks'), 'main');
    assert.equal(layout.owner('volume'), 'tab-show');
    assert.equal(layout.owner('logo'), undefined);
    assert.deepEqual(layout.tabs.flatMap(tab => tab.blocks).sort(), [...keys].sort());
    assert.equal(layout.tabs.length, 2);
});

test('moving blocks between tabs preserves unique ownership and order', () => {
    const layout = new CASWorkspaceLayout(keys);
    layout.add('tab-effects');
    layout.move('soundPads', 'tab-effects');
    layout.move('volume', 'tab-effects', 'soundPads');
    assert.deepEqual(layout.tabs[1].blocks, ['volume', 'soundPads']);
    layout.move('volume', 'tab-effects');
    assert.deepEqual(layout.tabs[1].blocks, ['soundPads', 'volume']);
    assert.equal(layout.move('logo', 'tab-effects'), false);
    assert.equal(layout.move('volume', 'missing'), false);
    assert.deepEqual(layout.tabs.flatMap(tab => tab.blocks).sort(), [...keys].sort());
});

test('deleting a workspace returns its blocks to the undeletable main tab', () => {
    const layout = new CASWorkspaceLayout(keys);
    layout.add('tab-effects');
    layout.move('soundPads', 'tab-effects');
    layout.move('volume', 'tab-effects');
    assert.equal(layout.remove('main'), false);
    assert.equal(layout.remove('missing'), false);
    assert.equal(layout.remove('tab-effects'), true);
    assert.equal(layout.activeTab, 'main');
    assert.deepEqual(layout.tabs[0].blocks.sort(), [...keys].sort());
});

test('workspace names, block placement and selection survive a saved-state round trip', () => {
    const layout = new CASWorkspaceLayout(keys);
    layout.add('tab-evening');
    layout.rename('tab-evening', '  Вечерняя программа  ');
    layout.move('nowPlaying', 'tab-evening');
    const restored = new CASWorkspaceLayout(keys, JSON.parse(JSON.stringify(layout.serialize())));
    assert.deepEqual(restored.serialize(), layout.serialize());
    assert.equal(restored.tabs[1].title, 'Вечерняя программа');
    assert.equal(restored.rename('main', 'Other'), false);
    assert.equal(restored.rename('tab-evening', '  '), false);
});

test('new blocks recover onto main when an older layout has no placement for them', () => {
    const previous = new CASWorkspaceLayout(['tracks']);
    previous.add('tab-show');
    previous.move('tracks', 'tab-show');
    const upgraded = new CASWorkspaceLayout(keys, previous.serialize());
    assert.equal(upgraded.owner('tracks'), 'tab-show');
    assert.equal(upgraded.owner('nowPlaying'), 'main');
    assert.deepEqual(upgraded.tabs.flatMap(tab => tab.blocks).sort(), [...keys].sort());
});

test('invalid moves cannot remove a block from its current tab', () => {
    const layout = new CASWorkspaceLayout(keys);
    layout.add('tab-show');
    const before = layout.serialize();
    assert.equal(layout.move('tracks', 'tab-show', 'volume'), false);
    assert.equal(layout.move('tracks', 'main', 'tracks'), false);
    assert.deepEqual(layout.serialize(), before);
});

test('workspace state is bounded and unknown versions start with a safe main layout', () => {
    const layout = new CASWorkspaceLayout(keys, { version: 100, tabs: [{ id: 'tab-old', blocks: keys }] });
    assert.deepEqual(layout.tabs[0].blocks, keys);
    for (let i = 0; i < 20; i++) layout.add(`tab-${i}`);
    assert.equal(layout.tabs.length, 12);
    const restored = new CASWorkspaceLayout(keys, layout.serialize());
    assert.equal(restored.tabs.length, 12);
});
