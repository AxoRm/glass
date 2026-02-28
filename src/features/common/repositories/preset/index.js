const sqliteRepository = require('./sqlite.repository');
const firebaseRepository = require('./firebase.repository');
const authService = require('../../services/authService');

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
                `[PresetRepository] ${operationName} failed on Firebase, falling back to SQLite:`,
                error?.message || error
            );
            return await sqliteOp();
        }
    }
    return await sqliteOp();
}

const presetRepositoryAdapter = {
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

    create: (options) => {
        const uid = authService.getCurrentUserId();
        return withFirebaseFallback(
            'create',
            () => firebaseRepository.create({ uid, ...options }),
            () => sqliteRepository.create({ uid, ...options })
        );
    },

    update: (id, options) => {
        const uid = authService.getCurrentUserId();
        return withFirebaseFallback(
            'update',
            () => firebaseRepository.update(id, options, uid),
            () => sqliteRepository.update(id, options, uid)
        );
    },

    delete: (id) => {
        const uid = authService.getCurrentUserId();
        return withFirebaseFallback(
            'delete',
            () => firebaseRepository.delete(id, uid),
            () => sqliteRepository.delete(id, uid)
        );
    },
};

module.exports = presetRepositoryAdapter;
