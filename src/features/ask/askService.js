const { BrowserWindow } = require('electron');
const { createStreamingLLM } = require('../common/ai/factory');
// Lazy require helper to avoid circular dependency issues
const getWindowManager = () => require('../../window/windowManager');
const internalBridge = require('../../bridge/internalBridge');

const getWindowPool = () => {
    try {
        return getWindowManager().windowPool;
    } catch {
        return null;
    }
};

const sessionRepository = require('../common/repositories/session');
const askRepository = require('./repositories');
const { getSystemPrompt } = require('../common/prompts/promptBuilder');
const path = require('node:path');
const fs = require('node:fs');
const os = require('os');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const { desktopCapturer } = require('electron');
const modelStateService = require('../common/services/modelStateService');
const settingsService = require('../settings/settingsService');

// Try to load sharp, but don't fail if it's not available
let sharp;
try {
    sharp = require('sharp');
    console.log('[AskService] Sharp module loaded successfully');
} catch (error) {
    console.warn('[AskService] Sharp module not available:', error.message);
    console.warn('[AskService] Screenshot functionality will work with reduced image processing capabilities');
    sharp = null;
}
let lastScreenshot = null;
const VOICE_DRAFT_MAX_AGE_MS = 10 * 60 * 1000;

async function captureScreenshot(options = {}) {
    if (process.platform === 'darwin') {
        try {
            const tempPath = path.join(os.tmpdir(), `screenshot-${Date.now()}.jpg`);

            await execFile('screencapture', ['-x', '-t', 'jpg', tempPath]);

            const imageBuffer = await fs.promises.readFile(tempPath);
            await fs.promises.unlink(tempPath);

            if (sharp) {
                try {
                    // Try using sharp for optimal image processing
                    const resizedBuffer = await sharp(imageBuffer)
                        .resize({ height: 384 })
                        .jpeg({ quality: 80 })
                        .toBuffer();

                    const base64 = resizedBuffer.toString('base64');
                    const metadata = await sharp(resizedBuffer).metadata();

                    lastScreenshot = {
                        base64,
                        width: metadata.width,
                        height: metadata.height,
                        timestamp: Date.now(),
                    };

                    return { success: true, base64, width: metadata.width, height: metadata.height };
                } catch (sharpError) {
                    console.warn('Sharp module failed, falling back to basic image processing:', sharpError.message);
                }
            }
            
            // Fallback: Return the original image without resizing
            console.log('[AskService] Using fallback image processing (no resize/compression)');
            const base64 = imageBuffer.toString('base64');
            
            lastScreenshot = {
                base64,
                width: null, // We don't have metadata without sharp
                height: null,
                timestamp: Date.now(),
            };

            return { success: true, base64, width: null, height: null };
        } catch (error) {
            console.error('Failed to capture screenshot:', error);
            return { success: false, error: error.message };
        }
    }

    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: 1920,
                height: 1080,
            },
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }
        const source = sources[0];
        const buffer = source.thumbnail.toJPEG(70);
        const base64 = buffer.toString('base64');
        const size = source.thumbnail.getSize();

        return {
            success: true,
            base64,
            width: size.width,
            height: size.height,
        };
    } catch (error) {
        console.error('Failed to capture screenshot using desktopCapturer:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * @class
 * @description
 */
class AskService {
    constructor() {
        this.abortController = null;
        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            showTextInput: true,
            voiceDraft: '',
            voiceSpeaker: '',
            voiceDraftTimestamp: 0,
        };
        console.log('[AskService] Service instance created.');
    }

    _broadcastState() {
        const askWindow = getWindowPool()?.get('ask');
        if (askWindow && !askWindow.isDestroyed()) {
            askWindow.webContents.send('ask:stateUpdate', this.state);
        }
    }

    setVoiceDraft(speaker, text) {
        const draft = typeof text === 'string' ? text.trim() : '';
        if (!draft) return;

        this.state = {
            ...this.state,
            voiceDraft: draft,
            voiceSpeaker: speaker || 'Me',
            voiceDraftTimestamp: Date.now(),
        };
        this._broadcastState();
    }

    _resolveEffectivePrompt(userPrompt) {
        const typedPrompt = typeof userPrompt === 'string' ? userPrompt.trim() : '';
        if (typedPrompt) return typedPrompt;

        const voiceDraft = this.state.voiceDraft?.trim();
        const draftAgeMs = Date.now() - (this.state.voiceDraftTimestamp || 0);
        if (voiceDraft && draftAgeMs <= VOICE_DRAFT_MAX_AGE_MS) {
            return voiceDraft;
        }

        return '';
    }

    async toggleAskButton(inputScreenOnly = false) {
        const askWindow = getWindowPool()?.get('ask');

        if (inputScreenOnly && (!askWindow || !askWindow.isVisible() || this.state.showTextInput)) {
            await this.sendMessage('', []);
            return;
        }

        const hasContent = this.state.isLoading || this.state.isStreaming || (this.state.currentResponse && this.state.currentResponse.length > 0);

        if (askWindow && askWindow.isVisible() && hasContent) {
            this.state.showTextInput = !this.state.showTextInput;
            this._broadcastState();
        } else {
            if (askWindow && askWindow.isVisible()) {
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
                this.state.isVisible = false;
            } else {
                console.log('[AskService] Showing hidden Ask window');
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
                this.state.isVisible = true;
            }
            if (this.state.isVisible) {
                this.state.showTextInput = true;
                this._broadcastState();
            }
        }
    }

    async closeAskWindow () {
            if (this.abortController) {
                this.abortController.abort('Window closed by user');
                this.abortController = null;
            }
    
            this.state = {
                isVisible      : false,
                isLoading      : false,
                isStreaming    : false,
                currentQuestion: '',
                currentResponse: '',
                showTextInput  : true,
                voiceDraft: this.state.voiceDraft || '',
                voiceSpeaker: this.state.voiceSpeaker || '',
                voiceDraftTimestamp: this.state.voiceDraftTimestamp || 0,
            };
            this._broadcastState();
    
            internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
    
            return { success: true };
        }
    

    /**
     * 
     * @param {string[]} conversationTexts
     * @returns {string}
     * @private
     */
    _formatConversationForPrompt(conversationTexts) {
        if (!conversationTexts || conversationTexts.length === 0) {
            return 'No conversation history available.';
        }
        return conversationTexts.slice(-30).join('\n');
    }

    /**
     * 
     * @param {string} userPrompt
     * @returns {Promise<{success: boolean, response?: string, error?: string}>}
     */
    async sendMessage(userPrompt, conversationHistoryRaw=[]) {
        const effectivePrompt = this._resolveEffectivePrompt(userPrompt);
        const userRequest = effectivePrompt || 'Analyze the current screen and provide the most relevant help right now.';

        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
        this.state = {
            ...this.state,
            isLoading: true,
            isStreaming: false,
            currentQuestion: effectivePrompt || '[Screen context]',
            currentResponse: '',
            showTextInput: false,
        };
        this._broadcastState();

        if (this.abortController) {
            this.abortController.abort('New request received.');
        }
        this.abortController = new AbortController();
        const { signal } = this.abortController;


        let sessionId;

        try {
            console.log(`[AskService] 🤖 Processing message: ${userRequest.substring(0, 80)}...`);

            sessionId = await sessionRepository.getOrCreateActive('ask');
            if (effectivePrompt) {
                await askRepository.addAiMessage({ sessionId, role: 'user', content: effectivePrompt });
                console.log(`[AskService] DB: Saved user prompt to session ${sessionId}`);
            }
            
            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key not configured.');
            }
            console.log(`[AskService] Using model: ${modelInfo.model} for provider: ${modelInfo.provider}`);

            const screenshotResult = await captureScreenshot({ quality: 'medium' });
            const screenshotBase64 = screenshotResult.success ? screenshotResult.base64 : null;

            const conversationHistory = this._formatConversationForPrompt(conversationHistoryRaw);
            const selectedPresetPrompt = await settingsService.getSelectedPresetPrompt();
            const reasoningEffort = await settingsService.getReasoningEffort();
            const appSettings = await settingsService.getSettings();
            const configuredMaxTokens = Number(appSettings?.maxTokens);

            const isGpt5Model = typeof modelInfo.model === 'string' && modelInfo.model.toLowerCase().startsWith('gpt-5');
            const reasoningIsHigh = reasoningEffort === 'high' || reasoningEffort === 'xhigh';
            const defaultMinTokens = (isGpt5Model && reasoningIsHigh) ? 8192 : 4096;
            const effectiveMaxTokens = Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
                ? Math.max(configuredMaxTokens, defaultMinTokens)
                : defaultMinTokens;

            const basePrompt = getSystemPrompt('pickle_glass_analysis', selectedPresetPrompt || '', false);
            const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', conversationHistory);

            const messages = [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `User Request: ${userRequest}` },
                    ],
                },
            ];

            if (screenshotBase64) {
                messages[1].content.push({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
                });
            }
            
            const streamingLLM = createStreamingLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: effectiveMaxTokens,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
                reasoningEffort,
            });

            try {
                const response = await streamingLLM.streamChat(messages);
                const askWin = getWindowPool()?.get('ask');

                if (!askWin || askWin.isDestroyed()) {
                    console.error("[AskService] Ask window is not available to send stream to.");
                    response.body.getReader().cancel();
                    return { success: false, error: 'Ask window is not available.' };
                }

                const reader = response.body.getReader();
                signal.addEventListener('abort', () => {
                    console.log(`[AskService] Aborting stream reader. Reason: ${signal.reason}`);
                    reader.cancel(signal.reason).catch(() => { /* 이미 취소된 경우의 오류는 무시 */ });
                });

                await this._processStream(reader, askWin, sessionId, signal, modelInfo.model);
                return { success: true };

            } catch (multimodalError) {
                // 멀티모달 요청이 실패했고 스크린샷이 포함되어 있다면 텍스트만으로 재시도
                if (screenshotBase64 && this._isMultimodalError(multimodalError)) {
                    console.log(`[AskService] Multimodal request failed, retrying with text-only: ${multimodalError.message}`);
                    
                    // 텍스트만으로 메시지 재구성
                    const textOnlyMessages = [
                        { role: 'system', content: systemPrompt },
                        {
                            role: 'user',
                            content: `User Request: ${userRequest}`
                        }
                    ];

                    const fallbackResponse = await streamingLLM.streamChat(textOnlyMessages);
                    const askWin = getWindowPool()?.get('ask');

                    if (!askWin || askWin.isDestroyed()) {
                        console.error("[AskService] Ask window is not available for fallback response.");
                        fallbackResponse.body.getReader().cancel();
                        return { success: false, error: 'Ask window is not available.' };
                    }

                    const fallbackReader = fallbackResponse.body.getReader();
                    signal.addEventListener('abort', () => {
                        console.log(`[AskService] Aborting fallback stream reader. Reason: ${signal.reason}`);
                        fallbackReader.cancel(signal.reason).catch(() => {});
                    });

                    await this._processStream(fallbackReader, askWin, sessionId, signal, modelInfo.model);
                    return { success: true };
                } else {
                    // 다른 종류의 에러이거나 스크린샷이 없었다면 그대로 throw
                    throw multimodalError;
                }
            }

        } catch (error) {
            console.error('[AskService] Error during message processing:', error);
            this.state = {
                ...this.state,
                isLoading: false,
                isStreaming: false,
                showTextInput: true,
            };
            this._broadcastState();

            const askWin = getWindowPool()?.get('ask');
            if (askWin && !askWin.isDestroyed()) {
                const streamError = error.message || 'Unknown error occurred';
                askWin.webContents.send('ask-response-stream-error', { error: streamError });
            }

            return { success: false, error: error.message };
        }
    }

    /**
     * 
     * @param {ReadableStreamDefaultReader} reader
     * @param {BrowserWindow} askWin
     * @param {number} sessionId 
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     * @private
     */
    async _processStream(reader, askWin, sessionId, signal, assistantModel = 'unknown') {
        const decoder = new TextDecoder();
        let fullResponse = '';
        let sseBuffer = '';
        let completedResponseText = '';

        try {
            this.state.isLoading = false;
            this.state.isStreaming = true;
            this._broadcastState();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                sseBuffer += chunk;
                const lines = sseBuffer.split('\n');
                sseBuffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine.startsWith('data:')) continue;

                    const data = trimmedLine.slice(5).trim();
                    if (data === '[DONE]') continue;

                    let json;
                    try {
                        json = JSON.parse(data);
                    } catch {
                        continue;
                    }

                    const streamError = this._extractErrorFromStreamEvent(json);
                    if (streamError) {
                        throw new Error(streamError);
                    }

                    const token = this._extractTokenFromStreamEvent(json);
                    if (token) {
                        fullResponse += token;
                        this.state.currentResponse = fullResponse;
                        this._broadcastState();
                    }

                    if (!completedResponseText) {
                        completedResponseText = this._extractCompletedTextFromStreamEvent(json);
                    }
                }
            }
        } catch (streamError) {
            if (signal.aborted) {
                console.log(`[AskService] Stream reading was intentionally cancelled. Reason: ${signal.reason}`);
            } else {
                console.error('[AskService] Error while processing stream:', streamError);
                if (askWin && !askWin.isDestroyed()) {
                    askWin.webContents.send('ask-response-stream-error', { error: streamError.message });
                }
            }
        } finally {
            if (!fullResponse && completedResponseText) {
                fullResponse = completedResponseText;
            }
            this.state.isStreaming = false;
            this.state.currentResponse = fullResponse;
            this._broadcastState();
            if (fullResponse) {
                 try {
                    await askRepository.addAiMessage({ sessionId, role: 'assistant', content: fullResponse, model: assistantModel });
                    console.log(`[AskService] DB: Saved partial or full assistant response to session ${sessionId} after stream ended.`);
                } catch(dbError) {
                    console.error("[AskService] DB: Failed to save assistant response after stream ended:", dbError);
                }
            }
        }
    }

    _extractTokenFromStreamEvent(eventPayload) {
        if (!eventPayload || typeof eventPayload !== 'object') return '';

        if (typeof eventPayload.delta === 'string') {
            return eventPayload.delta;
        }

        if (eventPayload.type === 'response.output_text.delta' && typeof eventPayload.delta === 'string') {
            return eventPayload.delta;
        }

        if (eventPayload.type === 'response.content_part.added') {
            const part = eventPayload?.part;
            if (typeof part?.text === 'string') return part.text;
        }

        if (eventPayload.type === 'response.content_part.delta') {
            const delta = eventPayload?.delta;
            if (typeof delta === 'string') return delta;
            if (typeof delta?.text === 'string') return delta.text;
        }

        const content = eventPayload?.choices?.[0]?.delta?.content;
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                    if (typeof part === 'string') return part;
                    if (!part || typeof part !== 'object') return '';
                    if (typeof part.text === 'string') return part.text;
                    if (typeof part.delta === 'string') return part.delta;
                    if (part.text && typeof part.text.value === 'string') return part.text.value;
                    return '';
                })
                .join('');
        }
        return '';
    }

    _extractCompletedTextFromStreamEvent(eventPayload) {
        if (!eventPayload || typeof eventPayload !== 'object') return '';

        const response = eventPayload.response;
        if (!response || typeof response !== 'object') return '';

        if (typeof response.output_text === 'string') {
            return response.output_text.trim();
        }

        if (Array.isArray(response.output_text)) {
            return response.output_text
                .map((part) => {
                    if (typeof part === 'string') return part;
                    if (!part || typeof part !== 'object') return '';
                    if (typeof part.text === 'string') return part.text;
                    return '';
                })
                .join('')
                .trim();
        }

        const output = Array.isArray(response.output) ? response.output : [];
        return output
            .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
            .map((part) => {
                if (!part || typeof part !== 'object') return '';
                if (typeof part.text === 'string') return part.text;
                if (part.text && typeof part.text.value === 'string') return part.text.value;
                return '';
            })
            .join('')
            .trim();
    }

    _extractErrorFromStreamEvent(eventPayload) {
        if (!eventPayload || typeof eventPayload !== 'object') return '';

        if (eventPayload.type === 'error') {
            return eventPayload?.error?.message || 'Unknown streaming error';
        }

        if (eventPayload.type === 'response.failed') {
            return eventPayload?.response?.error?.message || 'Response failed';
        }

        return '';
    }

    /**
     * 멀티모달 관련 에러인지 판단
     * @private
     */
    _isMultimodalError(error) {
        const errorMessage = error.message?.toLowerCase() || '';
        return (
            errorMessage.includes('vision') ||
            errorMessage.includes('image') ||
            errorMessage.includes('multimodal') ||
            errorMessage.includes('unsupported') ||
            errorMessage.includes('image_url') ||
            errorMessage.includes('400') ||  // Bad Request often for unsupported features
            errorMessage.includes('invalid') ||
            errorMessage.includes('not supported')
        );
    }

}

const askService = new AskService();

module.exports = askService;
