const sqliteRepository = require('./sqlite.repository');
const firebaseRepository = require('./firebase.repository');
const authService = require('../../common/services/authService');

function getBaseRepository() {
    const user = authService.getCurrentUser();
    if (user && user.isLoggedIn) {
        return firebaseRepository;
    }
    return sqliteRepository;
}

async function withFirebaseFallback(operationName, firebaseOp, sqliteOp) {
    const user = authService.getCurrentUser();
    if (user && user.isLoggedIn) {
        try {
            return await firebaseOp();
        } catch (error) {
            console.warn(
                `[SettingsPresetRepository] ${operationName} failed on Firebase, falling back to SQLite:`,
                error?.message || error
            );
            return await sqliteOp();
        }
    }
    return await sqliteOp();
}

const settingsRepositoryAdapter = {
    getPresets: () => {
        const uid = authService.getCurrentUserId();
        return withFirebaseFallback(
            'getPresets',
            () => firebaseRepository.getPresets(uid),
            () => sqliteRepository.getPresets(uid)
        );
    },

    getPresetTemplates: () => {
        return withFirebaseFallback(
            'getPresetTemplates',
            () => firebaseRepository.getPresetTemplates(),
            () => sqliteRepository.getPresetTemplates()
        );
    },

    createPreset: (options) => {
        const uid = authService.getCurrentUserId();
        return withFirebaseFallback(
            'createPreset',
            () => firebaseRepository.createPreset({ uid, ...options }),
            () => sqliteRepository.createPreset({ uid, ...options })
        );
    },

    updatePreset: (id, options) => {
        const uid = authService.getCurrentUserId();
        return withFirebaseFallback(
            'updatePreset',
            () => firebaseRepository.updatePreset(id, options, uid),
            () => sqliteRepository.updatePreset(id, options, uid)
        );
    },

    deletePreset: (id) => {
        const uid = authService.getCurrentUserId();
        return withFirebaseFallback(
            'deletePreset',
            () => firebaseRepository.deletePreset(id, uid),
            () => sqliteRepository.deletePreset(id, uid)
        );
    },

    getAutoUpdate: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getAutoUpdate(uid);
    },

    setAutoUpdate: (isEnabled) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().setAutoUpdate(uid, isEnabled);
    },
};

module.exports = settingsRepositoryAdapter;
