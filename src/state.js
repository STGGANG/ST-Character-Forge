import { extensionName } from './constants.js';

export const state = {
    settings: null,
    currentGeneration: null,
    isGenerating: false,
    operationId: 0,
    abortController: null,
    wiBooks: [],
    selectedCharIndex: -1,
    selectedCharKey: '',
    selectedCharData: null,
    lastRequest: null,
    progressListener: null,
};

export function log(msg) {
    console.log(`[${extensionName}] ${msg}`);
}

export function logError(context, error, details = {}) {
    console.error(`[${extensionName}] [${context}]`, error.message || error, details);
}

export function getSettings() {
    return state.settings;
}

let busyListener = null;

export function onBusyChange(listener) {
    busyListener = listener;
}

function notifyBusy() {
    try {
        busyListener?.(state.isGenerating);
    } catch (error) {
        console.error(`[${extensionName}] busy listener`, error);
    }
}

export function cancelledError() {
    const error = new Error('CANCELLED');
    error.name = 'AbortError';
    return error;
}

export function isCancelError(error) {
    return error?.name === 'AbortError' || error?.message === 'CANCELLED' || error?.cause?.name === 'AbortError';
}

export function beginOperation() {
    state.abortController?.abort();
    const controller = new AbortController();
    state.abortController = controller;
    state.operationId += 1;
    state.isGenerating = true;
    notifyBusy();
    return { id: state.operationId, signal: controller.signal };
}

export function isCurrentOperation(op) {
    return op.id === state.operationId && !op.signal.aborted;
}

export function endOperation(op) {
    if (op.id !== state.operationId) return;
    state.isGenerating = false;
    state.abortController = null;
    notifyBusy();
}

export function cancelOperation() {
    state.abortController?.abort(cancelledError());
    state.abortController = null;
    state.operationId += 1;
    state.isGenerating = false;
    notifyBusy();
}
