const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('macOS interface: application menu bar exists with all required top-level menus', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    assert.ok(html.includes('id="casMenuBar"'), 'App menu bar #casMenuBar must exist');
    assert.ok(html.includes('role="menubar"'), 'Menu bar must have semantic role="menubar"');

    const expectedMenus = ['Файл', 'Деки', 'Воспроизведение', 'Вкладки', 'Настройки', 'Справка'];
    for (const menuName of expectedMenus) {
        assert.ok(
            html.includes(`>${menuName}</button>`),
            `Menu trigger for "${menuName}" must exist in app menu bar`
        );
    }

    // Verify key menu actions exist
    assert.ok(html.includes('data-action="open-folder"'), 'Action to load playlist/folder must exist');
    assert.ok(html.includes('data-action="load-track-a"'), 'Action to load track into deck A must exist');
    assert.ok(html.includes('data-action="load-track-b"'), 'Action to load track into deck B must exist');
    assert.ok(html.includes('data-action="assign-pad"'), 'Action to assign sound to pad must exist');
    assert.ok(html.includes('data-action="open-settings"'), 'Action to open settings must exist');
    assert.ok(html.includes('data-action="quit"'), 'Action to quit must exist');
});

test('window controls: Windows caption buttons and macOS traffic lights are cleanly separated', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    assert.ok(html.includes('id="windowsWindowControls"'), 'Windows controls container #windowsWindowControls must exist');
    assert.ok(html.includes('id="winMinBtn"'), 'Windows minimize button #winMinBtn must exist');
    assert.ok(html.includes('id="winMaxBtn"'), 'Windows maximize button #winMaxBtn must exist');
    assert.ok(html.includes('id="winCloseBtn"'), 'Windows close button #winCloseBtn must exist');

    assert.ok(html.includes('id="macWindowControls"'), 'macOS controls container #macWindowControls must exist');
    assert.ok(html.includes('id="macCloseBtn"'), 'macOS close traffic light must exist');
    assert.ok(html.includes('id="macMinBtn"'), 'macOS minimize traffic light must exist');
    assert.ok(html.includes('id="macMaxBtn"'), 'macOS maximize traffic light must exist');
});

test('header cleanup: bulky title and bottom footer removed, modern status pill present', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    // Bulky old text must be removed
    assert.ok(!html.includes('<strong>Рабочее пространство</strong>'), 'Old "Рабочее пространство" title must be removed from header');

    // Clunky footer removed
    assert.ok(!html.includes('<footer class="workspace-footer">'), 'Old bottom footer <footer class="workspace-footer"> must be removed');

    // Modern status pill in header
    assert.ok(html.includes('class="header-status-pill" id="status"'), 'Header status pill with id="status" must exist');
    assert.ok(html.includes('class="status-indicator-dot"'), 'Status pill must contain status dot indicator');
    assert.ok(html.includes('class="status-indicator-text"'), 'Status pill must contain status text element');

    // Broken settings button in tabs removed
    assert.ok(!html.includes('id="workspaceSettingsBtn"'), 'Broken cut off settings button in tab actions must be removed');

    // About dialog present
    assert.ok(html.includes('id="aboutDialog"'), 'About dialog #aboutDialog must exist');
    assert.ok(html.includes('Версия 1.6.0'), 'About dialog must show current version 1.6.0');
});

test('CSS: toolbar and workspace panels adjust height properly without footer', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'console.css'), 'utf8');

    assert.ok(css.includes('.cas-menu-bar'), 'CSS must define .cas-menu-bar');
    assert.ok(css.includes('.cas-menu-dropdown'), 'CSS must define .cas-menu-dropdown');
    assert.ok(css.includes('.windows-window-controls'), 'CSS must define .windows-window-controls');
    assert.ok(css.includes('.win-close-btn:hover'), 'CSS must define Windows close red hover style');
    assert.ok(css.includes('#workspacePanels { position: relative; height: calc(100vh - 74px);'), 'workspacePanels height must be 100vh - 74px without footer');
});

test('renderer & workspaces: keyboard accessibility and settings status handling', () => {
    const rendererJs = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const workspacesJs = fs.readFileSync(path.join(__dirname, '..', 'workspaces.js'), 'utf8');

    // Menu keyboard navigation
    assert.ok(rendererJs.includes("e.key === 'ArrowRight'"), 'renderer.js must handle ArrowRight navigation for menu bar');
    assert.ok(rendererJs.includes("e.key === 'ArrowLeft'"), 'renderer.js must handle ArrowLeft navigation for menu bar');
    assert.ok(rendererJs.includes("e.key === 'ArrowDown'"), 'renderer.js must handle ArrowDown navigation for menu dropdowns');
    assert.ok(rendererJs.includes("e.key === 'ArrowUp'"), 'renderer.js must handle ArrowUp navigation for menu dropdowns');

    // Hotkeys guard for #casMenuBar
    assert.ok(rendererJs.includes('#casMenuBar'), 'renderer.js handleHotkeys must guard #casMenuBar from hotkey interference');

    // Settings status restoration
    assert.ok(workspacesJs.includes("this.mixer.updateStatus('Готов к работе')"), 'workspaces.js must restore status on deactivating settings');
});
