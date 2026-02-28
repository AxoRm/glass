const { ipcMain, BrowserWindow } = require('electron');
const Store = require('electron-store');
const authService = require('../common/services/authService');
const settingsRepository = require('./repositories');
const { getStoredApiKey, getStoredProvider, windowPool } = require('../../window/windowManager');

// New imports for common services
const modelStateService = require('../common/services/modelStateService');
const localAIManager = require('../common/services/localAIManager');

const store = new Store({
    name: 'pickle-glass-settings',
    defaults: {
        users: {}
    }
});

// Configuration constants
const NOTIFICATION_CONFIG = {
    RELEVANT_WINDOW_TYPES: ['settings', 'main'],
    DEBOUNCE_DELAY: 300, // prevent spam during bulk operations (ms)
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_BASE_DELAY: 1000, // exponential backoff base (ms)
};

// New facade functions for model state management
async function getModelSettings() {
    try {
        const [config, storedKeys, selectedModels, availableLlm, availableStt] = await Promise.all([
            modelStateService.getProviderConfig(),
            modelStateService.getAllApiKeys(),
            modelStateService.getSelectedModels(),
            modelStateService.getAvailableModels('llm'),
            modelStateService.getAvailableModels('stt')
        ]);
        
        return { success: true, data: { config, storedKeys, availableLlm, availableStt, selectedModels } };
    } catch (error) {
        console.error('[SettingsService] Error getting model settings:', error);
        return { success: false, error: error.message };
    }
}

async function clearApiKey(provider) {
    const success = await modelStateService.handleRemoveApiKey(provider);
    return { success };
}

async function setSelectedModel(type, modelId) {
    const success = await modelStateService.handleSetSelectedModel(type, modelId);
    return { success };
}

// LocalAI facade functions
async function getOllamaStatus() {
    return localAIManager.getServiceStatus('ollama');
}

async function ensureOllamaReady() {
    const status = await localAIManager.getServiceStatus('ollama');
    if (!status.installed || !status.running) {
        await localAIManager.startService('ollama');
    }
    return { success: true };
}

async function shutdownOllama() {
    return localAIManager.stopService('ollama');
}


// window targeting system
class WindowNotificationManager {
    constructor() {
        this.pendingNotifications = new Map();
    }

    /**
     * Send notifications only to relevant windows
     * @param {string} event - Event name
     * @param {*} data - Event data
     * @param {object} options - Notification options
     */
    notifyRelevantWindows(event, data = null, options = {}) {
        const { 
            windowTypes = NOTIFICATION_CONFIG.RELEVANT_WINDOW_TYPES,
            debounce = NOTIFICATION_CONFIG.DEBOUNCE_DELAY 
        } = options;

        if (debounce > 0) {
            this.debounceNotification(event, () => {
                this.sendToTargetWindows(event, data, windowTypes);
            }, debounce);
        } else {
            this.sendToTargetWindows(event, data, windowTypes);
        }
    }

    sendToTargetWindows(event, data, windowTypes) {
        const relevantWindows = this.getRelevantWindows(windowTypes);
        
        if (relevantWindows.length === 0) {
            console.log(`[WindowNotificationManager] No relevant windows found for event: ${event}`);
            return;
        }

        console.log(`[WindowNotificationManager] Sending ${event} to ${relevantWindows.length} relevant windows`);
        
        relevantWindows.forEach(win => {
            try {
                if (data) {
                    win.webContents.send(event, data);
                } else {
                    win.webContents.send(event);
                }
            } catch (error) {
                console.warn(`[WindowNotificationManager] Failed to send ${event} to window:`, error.message);
            }
        });
    }

    getRelevantWindows(windowTypes) {
        const allWindows = BrowserWindow.getAllWindows();
        const relevantWindows = [];

        allWindows.forEach(win => {
            if (win.isDestroyed()) return;

            for (const [windowName, poolWindow] of windowPool || []) {
                if (poolWindow === win && windowTypes.includes(windowName)) {
                    if (windowName === 'settings' || win.isVisible()) {
                        relevantWindows.push(win);
                    }
                    break;
                }
            }
        });

        return relevantWindows;
    }

    debounceNotification(key, fn, delay) {
        // Clear existing timeout
        if (this.pendingNotifications.has(key)) {
            clearTimeout(this.pendingNotifications.get(key));
        }

        // Set new timeout
        const timeoutId = setTimeout(() => {
            fn();
            this.pendingNotifications.delete(key);
        }, delay);

        this.pendingNotifications.set(key, timeoutId);
    }

    cleanup() {
        // Clear all pending notifications
        this.pendingNotifications.forEach(timeoutId => clearTimeout(timeoutId));
        this.pendingNotifications.clear();
    }
}

// Global instance
const windowNotificationManager = new WindowNotificationManager();

// Default keybinds configuration
const DEFAULT_KEYBINDS = {
    mac: {
        moveUp: 'Cmd+Alt+Up',
        moveDown: 'Cmd+Alt+Down',
        moveLeft: 'Cmd+Alt+Left',
        moveRight: 'Cmd+Alt+Right',
        toggleVisibility: 'Cmd+Alt+H',
        toggleClickThrough: 'Cmd+Alt+C',
        nextStep: 'Cmd+Alt+A',
        toggleListen: 'Cmd+Alt+L',
        toggleSettings: 'Cmd+Alt+S',
        manualScreenshot: 'Cmd+Alt+X',
        previousResponse: 'Cmd+Alt+[',
        nextResponse: 'Cmd+Alt+]',
        scrollUp: 'Cmd+Alt+K',
        scrollDown: 'Cmd+Alt+J',
    },
    windows: {
        moveUp: 'Ctrl+Alt+Up',
        moveDown: 'Ctrl+Alt+Down',
        moveLeft: 'Ctrl+Alt+Left',
        moveRight: 'Ctrl+Alt+Right',
        toggleVisibility: 'Ctrl+Alt+H',
        toggleClickThrough: 'Ctrl+Alt+C',
        nextStep: 'Ctrl+Alt+A',
        toggleListen: 'Ctrl+Alt+L',
        toggleSettings: 'Ctrl+Alt+S',
        manualScreenshot: 'Ctrl+Alt+X',
        previousResponse: 'Ctrl+Alt+[',
        nextResponse: 'Ctrl+Alt+]',
        scrollUp: 'Ctrl+Alt+K',
        scrollDown: 'Ctrl+Alt+J',
    }
};

// Service state
let currentSettings = null;
const REASONING_EFFORT_VALUES = ['none', 'low', 'medium', 'high', 'xhigh'];

function normalizeReasoningEffort(value) {
    const candidate = (typeof value === 'string' ? value.trim().toLowerCase() : '');
    if (candidate === 'minimal') return 'none';
    if (candidate === 'x-high' || candidate === 'x_high' || candidate === 'x high') return 'xhigh';
    return REASONING_EFFORT_VALUES.includes(candidate) ? candidate : 'medium';
}

function getDefaultSettings() {
    const isMac = process.platform === 'darwin';
    return {
        profile: 'school',
        selectedPresetId: null,
        language: 'en',
        screenshotInterval: '5000',
        imageQuality: '0.8',
        layoutMode: 'stacked',
        keybinds: isMac ? DEFAULT_KEYBINDS.mac : DEFAULT_KEYBINDS.windows,
        throttleTokens: 500,
        maxTokens: 4096,
        throttlePercent: 80,
        googleSearchEnabled: false,
        backgroundTransparency: 0.5,
        fontSize: 14,
        contentProtection: true,
        reasoningEffort: 'medium'
    };
}

async function getSettings() {
    try {
        const uid = authService.getCurrentUserId();
        const userSettingsKey = uid ? `users.${uid}` : 'users.default';
        
        const defaultSettings = getDefaultSettings();
        const savedSettings = store.get(userSettingsKey, {});
        
        currentSettings = { ...defaultSettings, ...savedSettings };
        return currentSettings;
    } catch (error) {
        console.error('[SettingsService] Error getting settings from store:', error);
        return getDefaultSettings();
    }
}

async function saveSettings(settings) {
    try {
        const uid = authService.getCurrentUserId();
        const userSettingsKey = uid ? `users.${uid}` : 'users.default';
        
        const currentSaved = store.get(userSettingsKey, {});
        const newSettings = { ...currentSaved, ...settings };
        
        store.set(userSettingsKey, newSettings);
        currentSettings = newSettings;
        
        // Use smart notification system
        windowNotificationManager.notifyRelevantWindows('settings-updated', currentSettings);

        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error saving settings to store:', error);
        return { success: false, error: error.message };
    }
}

async function getPresets() {
    try {
        // The adapter now handles which presets to return based on login state.
        const presets = await settingsRepository.getPresets();
        return presets;
    } catch (error) {
        console.error('[SettingsService] Error getting presets:', error);
        return [];
    }
}

async function getSelectedPresetId() {
    try {
        const settings = await getSettings();
        return settings?.selectedPresetId || null;
    } catch (error) {
        console.error('[SettingsService] Error getting selected preset id:', error);
        return null;
    }
}

async function setSelectedPresetId(presetId) {
    try {
        return await saveSettings({ selectedPresetId: presetId || null });
    } catch (error) {
        console.error('[SettingsService] Error setting selected preset id:', error);
        return { success: false, error: error.message };
    }
}

async function getSelectedPresetPrompt() {
    try {
        const selectedPresetId = await getSelectedPresetId();
        if (!selectedPresetId) return '';

        const presets = await getPresets();
        const selectedPreset = presets.find((preset) => preset.id === selectedPresetId);
        return selectedPreset?.prompt || '';
    } catch (error) {
        console.error('[SettingsService] Error getting selected preset prompt:', error);
        return '';
    }
}

async function getPresetTemplates() {
    try {
        const templates = await settingsRepository.getPresetTemplates();
        return templates;
    } catch (error) {
        console.error('[SettingsService] Error getting preset templates:', error);
        return [];
    }
}

async function createPreset(title, prompt) {
    try {
        // The adapter injects the UID.
        const result = await settingsRepository.createPreset({ title, prompt });
        
        windowNotificationManager.notifyRelevantWindows('presets-updated', {
            action: 'created',
            presetId: result.id,
            title
        });
        
        return { success: true, id: result.id };
    } catch (error) {
        console.error('[SettingsService] Error creating preset:', error);
        return { success: false, error: error.message };
    }
}

async function updatePreset(id, title, prompt) {
    try {
        // The adapter injects the UID.
        await settingsRepository.updatePreset(id, { title, prompt });
        
        windowNotificationManager.notifyRelevantWindows('presets-updated', {
            action: 'updated',
            presetId: id,
            title
        });
        
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error updating preset:', error);
        return { success: false, error: error.message };
    }
}

async function deletePreset(id) {
    try {
        // The adapter injects the UID.
        await settingsRepository.deletePreset(id);
        
        windowNotificationManager.notifyRelevantWindows('presets-updated', {
            action: 'deleted',
            presetId: id
        });
        
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error deleting preset:', error);
        return { success: false, error: error.message };
    }
}

async function saveApiKey(apiKey, provider = 'openai') {
    try {
        // Use ModelStateService as the single source of truth for API key management
        const modelStateService = global.modelStateService;
        if (!modelStateService) {
            throw new Error('ModelStateService not initialized');
        }
        
        await modelStateService.setApiKey(provider, apiKey);
        
        // Notify windows
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('api-key-validated', apiKey);
            }
        });
        
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error saving API key:', error);
        return { success: false, error: error.message };
    }
}

async function removeApiKey() {
    try {
        // Use ModelStateService as the single source of truth for API key management
        const modelStateService = global.modelStateService;
        if (!modelStateService) {
            throw new Error('ModelStateService not initialized');
        }
        
        // Remove all API keys for all providers
        const providers = ['openai', 'anthropic', 'gemini', 'ollama', 'whisper'];
        for (const provider of providers) {
            await modelStateService.removeApiKey(provider);
        }
        
        // Notify windows
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('api-key-removed');
            }
        });
        
        console.log('[SettingsService] API key removed for all providers');
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error removing API key:', error);
        return { success: false, error: error.message };
    }
}

async function updateContentProtection(enabled) {
    try {
        const settings = await getSettings();
        settings.contentProtection = enabled;
        
        // Update content protection in main window
        const { app } = require('electron');
        const mainWindow = windowPool.get('main');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setContentProtection(enabled);
        }
        
        return await saveSettings(settings);
    } catch (error) {
        console.error('[SettingsService] Error updating content protection:', error);
        return { success: false, error: error.message };
    }
}

async function getAutoUpdateSetting() {
    try {
        return settingsRepository.getAutoUpdate();
    } catch (error) {
        console.error('[SettingsService] Error getting auto update setting:', error);
        return true; // Fallback to enabled
    }
}

async function setAutoUpdateSetting(isEnabled) {
    try {
        await settingsRepository.setAutoUpdate(isEnabled);
        return { success: true };
    } catch (error) {
        console.error('[SettingsService] Error setting auto update setting:', error);
        return { success: false, error: error.message };
    }
}

async function getReasoningEffort() {
    try {
        const settings = await getSettings();
        return normalizeReasoningEffort(settings?.reasoningEffort);
    } catch (error) {
        console.error('[SettingsService] Error getting reasoning effort:', error);
        return 'medium';
    }
}

async function setReasoningEffort(value) {
    try {
        const reasoningEffort = normalizeReasoningEffort(value);
        return await saveSettings({ reasoningEffort });
    } catch (error) {
        console.error('[SettingsService] Error setting reasoning effort:', error);
        return { success: false, error: error.message };
    }
}

function initialize() {
    // cleanup 
    windowNotificationManager.cleanup();
    
    console.log('[SettingsService] Initialized and ready.');
}

// Cleanup function
function cleanup() {
    windowNotificationManager.cleanup();
    console.log('[SettingsService] Cleaned up resources.');
}

function notifyPresetUpdate(action, presetId, title = null) {
    const data = { action, presetId };
    if (title) data.title = title;
    
    windowNotificationManager.notifyRelevantWindows('presets-updated', data);
}

module.exports = {
    initialize,
    cleanup,
    notifyPresetUpdate,
    getSettings,
    saveSettings,
    getPresets,
    getPresetTemplates,
    createPreset,
    updatePreset,
    deletePreset,
    saveApiKey,
    removeApiKey,
    updateContentProtection,
    getAutoUpdateSetting,
    setAutoUpdateSetting,
    getReasoningEffort,
    setReasoningEffort,
    // Model settings facade
    getModelSettings,
    clearApiKey,
    setSelectedModel,
    getSelectedPresetId,
    setSelectedPresetId,
    getSelectedPresetPrompt,
    // Ollama facade
    getOllamaStatus,
    ensureOllamaReady,
    shutdownOllama
};
