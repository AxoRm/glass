const { globalShortcut, screen } = require('electron');
const shortcutsRepository = require('./repositories');
const internalBridge = require('../../bridge/internalBridge');
const askService = require('../ask/askService');
const listenService = require('../listen/listenService');


class ShortcutsService {
    constructor() {
        this.lastVisibleWindows = new Set(['header']);
        this.mouseEventsIgnored = false;
        this.windowPool = null;
        this.allWindowVisibility = true;
    }

    initialize(windowPool) {
        this.windowPool = windowPool;
        internalBridge.on('reregister-shortcuts', () => {
            console.log('[ShortcutsService] Reregistering shortcuts due to header state change.');
            this.registerShortcuts();
        });
        console.log('[ShortcutsService] Initialized with dependencies and event listener.');
    }

    async openShortcutSettingsWindow () {
        const keybinds = await this.loadKeybinds();
        const shortcutWin = this.windowPool.get('shortcut-settings');
        shortcutWin.webContents.send('shortcut:loadShortcuts', keybinds);

        globalShortcut.unregisterAll();
        internalBridge.emit('window:requestVisibility', { name: 'shortcut-settings', visible: true });
        console.log('[ShortcutsService] Shortcut settings window opened.');
        return { success: true };
    }

    async closeShortcutSettingsWindow () {
        await this.registerShortcuts();
        internalBridge.emit('window:requestVisibility', { name: 'shortcut-settings', visible: false });
        console.log('[ShortcutsService] Shortcut settings window closed.');
        return { success: true };
    }

    async handleSaveShortcuts(newKeybinds) {
        try {
            await this.saveKeybinds(newKeybinds);
            await this.closeShortcutSettingsWindow();
            return { success: true };
        } catch (error) {
            console.error("Failed to save shortcuts:", error);
            await this.closeShortcutSettingsWindow();
            return { success: false, error: error.message };
        }
    }

    async handleRestoreDefaults() {
        const defaults = this.getDefaultKeybinds();
        return defaults;
    }

    getDefaultKeybinds() {
        const isMac = process.platform === 'darwin';
        return {
            moveUp: isMac ? 'Cmd+Alt+Up' : 'Ctrl+Alt+Up',
            moveDown: isMac ? 'Cmd+Alt+Down' : 'Ctrl+Alt+Down',
            moveLeft: isMac ? 'Cmd+Alt+Left' : 'Ctrl+Alt+Left',
            moveRight: isMac ? 'Cmd+Alt+Right' : 'Ctrl+Alt+Right',
            toggleVisibility: isMac ? 'Cmd+Alt+H' : 'Ctrl+Alt+H',
            toggleClickThrough: isMac ? 'Cmd+Alt+C' : 'Ctrl+Alt+C',
            nextStep: isMac ? 'Cmd+Alt+A' : 'Ctrl+Alt+A',
            toggleListen: isMac ? 'Cmd+Alt+L' : 'Ctrl+Alt+L',
            toggleSettings: isMac ? 'Cmd+Alt+S' : 'Ctrl+Alt+S',
            manualScreenshot: isMac ? 'Cmd+Alt+X' : 'Ctrl+Alt+X',
            previousResponse: isMac ? 'Cmd+Alt+[' : 'Ctrl+Alt+[',
            nextResponse: isMac ? 'Cmd+Alt+]' : 'Ctrl+Alt+]',
            scrollUp: isMac ? 'Cmd+Alt+K' : 'Ctrl+Alt+K',
            scrollDown: isMac ? 'Cmd+Alt+J' : 'Ctrl+Alt+J',
        };
    }

    getLegacyDefaultKeybinds() {
        const isMac = process.platform === 'darwin';
        return {
            moveUp: isMac ? 'Cmd+Up' : 'Ctrl+Up',
            moveDown: isMac ? 'Cmd+Down' : 'Ctrl+Down',
            moveLeft: isMac ? 'Cmd+Left' : 'Ctrl+Left',
            moveRight: isMac ? 'Cmd+Right' : 'Ctrl+Right',
            toggleVisibility: isMac ? 'Cmd+\\' : 'Ctrl+\\',
            toggleClickThrough: isMac ? 'Cmd+M' : 'Ctrl+M',
            nextStep: isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
            manualScreenshot: isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S',
            previousResponse: isMac ? 'Cmd+[' : 'Ctrl+[',
            nextResponse: isMac ? 'Cmd+]' : 'Ctrl+]',
            scrollUp: isMac ? 'Cmd+Shift+Up' : 'Ctrl+Shift+Up',
            scrollDown: isMac ? 'Cmd+Shift+Down' : 'Ctrl+Shift+Down',
        };
    }

    async loadKeybinds() {
        let keybindsArray = await shortcutsRepository.getAllKeybinds();

        if (!keybindsArray || keybindsArray.length === 0) {
            console.log(`[Shortcuts] No keybinds found. Loading defaults.`);
            const defaults = this.getDefaultKeybinds();
            await this.saveKeybinds(defaults); 
            return defaults;
        }

        const keybinds = {};
        keybindsArray.forEach(k => {
            keybinds[k.action] = k.accelerator;
        });

        const defaults = this.getDefaultKeybinds();
        const legacyDefaults = this.getLegacyDefaultKeybinds();
        let needsUpdate = false;
        for (const action in defaults) {
            if (!keybinds[action]) {
                keybinds[action] = defaults[action];
                needsUpdate = true;
                continue;
            }
            if (keybinds[action] === legacyDefaults[action]) {
                keybinds[action] = defaults[action];
                needsUpdate = true;
            }
            if (
                action === 'toggleVisibility' &&
                (
                    keybinds[action] === 'Ctrl+Alt+Shift+H' ||
                    keybinds[action] === 'Cmd+Alt+Shift+H'
                )
            ) {
                keybinds[action] = defaults[action];
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            console.log('[Shortcuts] Updating missing keybinds with defaults.');
            await this.saveKeybinds(keybinds);
        }

        return keybinds;
    }

    async saveKeybinds(newKeybinds) {
        const keybindsToSave = [];
        for (const action in newKeybinds) {
            if (Object.prototype.hasOwnProperty.call(newKeybinds, action)) {
                keybindsToSave.push({
                    action: action,
                    accelerator: newKeybinds[action],
                });
            }
        }
        await shortcutsRepository.upsertKeybinds(keybindsToSave);
        console.log(`[Shortcuts] Saved keybinds.`);
    }

    async toggleAllWindowsVisibility() {
        const targetVisibility = !this.allWindowVisibility;
        internalBridge.emit('window:requestToggleAllWindowsVisibility', {
            targetVisibility: targetVisibility
        });

        if (this.allWindowVisibility) {
            await this.registerShortcuts(true);
        } else {
            await this.registerShortcuts();
        }

        this.allWindowVisibility = !this.allWindowVisibility;
    }

    applyClickThroughStateToWindow(win) {
        if (!win || win.isDestroyed()) return;
        if (this.mouseEventsIgnored) {
            // Keep window fully transparent for mouse so OS cursor comes from background app.
            win.setIgnoreMouseEvents(true);
            return;
        }
        win.setIgnoreMouseEvents(false);
    }

    applyClickThroughStateToAllWindows() {
        if (!this.windowPool) return;
        this.windowPool.forEach((win) => this.applyClickThroughStateToWindow(win));
    }

    toggleClickThrough(sendToRenderer) {
        this.mouseEventsIgnored = !this.mouseEventsIgnored;
        this.applyClickThroughStateToAllWindows();

        if (typeof sendToRenderer === 'function') {
            sendToRenderer('click-through-toggled', this.mouseEventsIgnored);
        }
    }

    _scrollWindow(win, direction) {
        if (!win || win.isDestroyed() || !win.isVisible()) return false;
        const delta = direction === 'up' ? -120 : 120;
        const script = `
            (() => {
                const delta = ${delta};
                const canScroll = (el) => {
                    if (!el || !(el instanceof Element)) return false;
                    const style = window.getComputedStyle(el);
                    const overflow = style.overflowY || '';
                    return /(auto|scroll)/.test(overflow) && el.scrollHeight > el.clientHeight + 2;
                };
                const active = document.activeElement;
                const nodes = [active, ...document.querySelectorAll('*')].filter(Boolean);
                const target = nodes.find(canScroll) || document.scrollingElement || document.documentElement || document.body;
                if (!target) return false;
                target.scrollTop = (target.scrollTop || 0) + delta;
                return true;
            })();
        `;

        win.webContents.executeJavaScript(script, true).catch(() => {});
        return true;
    }

    _scrollVisibleWindows(direction) {
        const preferredOrder = ['ask', 'settings', 'listen', 'shortcut-settings'];
        for (const name of preferredOrder) {
            const win = this.windowPool.get(name);
            if (this._scrollWindow(win, direction)) {
                if (name === 'ask') {
                    const channel = direction === 'up' ? 'scroll-response-up' : 'scroll-response-down';
                    win.webContents.send(channel);
                }
                return;
            }
        }
    }

    _toggleSettingsWindow() {
        const settingsWindow = this.windowPool.get('settings');
        const shouldShow = !(settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible());
        internalBridge.emit('window:requestVisibility', { name: 'settings', visible: shouldShow });
    }

    async _toggleListenSession() {
        const listenWindow = this.windowPool.get('listen');
        const isActive = listenService.isSessionActive();
        const isListenVisible = Boolean(listenWindow && !listenWindow.isDestroyed() && listenWindow.isVisible());

        const listenButtonText = isActive ? 'Stop' : (isListenVisible ? 'Done' : 'Listen');
        await listenService.handleListenRequest(listenButtonText);
    }

    async registerShortcuts(registerOnlyToggleVisibility = false) {
        if (!this.windowPool) {
            console.error('[Shortcuts] Service not initialized. Cannot register shortcuts.');
            return;
        }
        const keybinds = await this.loadKeybinds();
        globalShortcut.unregisterAll();
        
        const header = this.windowPool.get('header');
        const mainWindow = header;

        const sendToRenderer = (channel, ...args) => {
            this.windowPool.forEach(win => {
                if (win && !win.isDestroyed()) {
                    try {
                        win.webContents.send(channel, ...args);
                    } catch (e) {
                        // Ignore errors for destroyed windows
                    }
                }
            });
        };
        
        sendToRenderer('shortcuts-updated', keybinds);
        this.applyClickThroughStateToAllWindows();
        sendToRenderer('click-through-toggled', this.mouseEventsIgnored);

        const registerToggleVisibilityWithAliases = () => {
            const isMac = process.platform === 'darwin';
            const explicitAlias = isMac ? 'Cmd+\\' : 'Ctrl+\\';
            const aliases = [keybinds.toggleVisibility];
            if (explicitAlias !== keybinds.toggleVisibility) {
                aliases.push(explicitAlias);
            }

            for (const accelerator of aliases) {
                try {
                    globalShortcut.register(accelerator, () => this.toggleAllWindowsVisibility());
                } catch (error) {
                    console.error(`[Shortcuts] Failed to register toggleVisibility alias (${accelerator}):`, error.message);
                }
            }
        };

        if (registerOnlyToggleVisibility) {
            registerToggleVisibilityWithAliases();
            console.log('[Shortcuts] registerOnlyToggleVisibility, only toggleVisibility shortcut is registered.');
            return;
        }

        // --- Hardcoded shortcuts ---
        const isMac = process.platform === 'darwin';
        const modifier = isMac ? 'Cmd' : 'Ctrl';
        
        // Monitor switching
        const displays = screen.getAllDisplays();
        if (displays.length > 1) {
            displays.forEach((display, index) => {
                const key = `${modifier}+Shift+${index + 1}`;
                globalShortcut.register(key, () => internalBridge.emit('window:moveToDisplay', { displayId: display.id }));
            });
        }

        // Edge snapping
        const edgeDirections = [
            { key: `${modifier}+Shift+Left`, direction: 'left' },
            { key: `${modifier}+Shift+Right`, direction: 'right' },
        ];
        edgeDirections.forEach(({ key, direction }) => {
            globalShortcut.register(key, () => {
                if (header && header.isVisible()) internalBridge.emit('window:moveToEdge', { direction });
            });
        });

        // --- User-configurable shortcuts ---
        if (header?.currentHeaderState === 'apikey') {
            registerToggleVisibilityWithAliases();
            console.log('[Shortcuts] ApiKeyHeader is active, only toggleVisibility shortcut is registered.');
            return;
        }

        for (const action in keybinds) {
            const accelerator = keybinds[action];
            if (!accelerator) continue;

            let callback;
            switch(action) {
                case 'toggleVisibility':
                    callback = () => this.toggleAllWindowsVisibility();
                    break;
                case 'nextStep':
                    callback = () => askService.toggleAskButton(true);
                    break;
                case 'scrollUp':
                    callback = () => this._scrollVisibleWindows('up');
                    break;
                case 'scrollDown':
                    callback = () => this._scrollVisibleWindows('down');
                    break;
                case 'moveUp':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveStep', { direction: 'up' }); };
                    break;
                case 'moveDown':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveStep', { direction: 'down' }); };
                    break;
                case 'moveLeft':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveStep', { direction: 'left' }); };
                    break;
                case 'moveRight':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveStep', { direction: 'right' }); };
                    break;
                case 'toggleClickThrough':
                    callback = () => this.toggleClickThrough(sendToRenderer);
                    break;
                case 'toggleListen':
                    callback = async () => {
                        try {
                            await this._toggleListenSession();
                        } catch (error) {
                            console.error('[Shortcuts] toggleListen failed:', error.message);
                        }
                    };
                    break;
                case 'toggleSettings':
                    callback = () => this._toggleSettingsWindow();
                    break;
                case 'manualScreenshot':
                    callback = () => {
                        if(mainWindow && !mainWindow.isDestroyed()) {
                             mainWindow.webContents.executeJavaScript('window.captureManualScreenshot && window.captureManualScreenshot();');
                        }
                    };
                    break;
                case 'previousResponse':
                    callback = () => sendToRenderer('navigate-previous-response');
                    break;
                case 'nextResponse':
                    callback = () => sendToRenderer('navigate-next-response');
                    break;
            }
            
            if (callback) {
                try {
                    globalShortcut.register(accelerator, callback);
                } catch(e) {
                    console.error(`[Shortcuts] Failed to register shortcut for "${action}" (${accelerator}):`, e.message);
                }
            }
        }
        console.log('[Shortcuts] All shortcuts have been registered.');
    }

    unregisterAll() {
        globalShortcut.unregisterAll();
        console.log('[Shortcuts] All shortcuts have been unregistered.');
    }
}


const shortcutsService = new ShortcutsService();

module.exports = shortcutsService;
