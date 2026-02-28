const WebSocket = require('ws');

function isGpt5Model(model) {
  return typeof model === 'string' && model.toLowerCase().startsWith('gpt-5');
}

function normalizeMessagesForModel(model, messages) {
  if (!Array.isArray(messages)) return [];
  if (!isGpt5Model(model)) return messages;

  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (message.role === 'system') {
      return { ...message, role: 'developer' };
    }
    return message;
  });
}

function buildTokenPayload(model, maxTokens, options = {}) {
  if (!maxTokens || typeof maxTokens !== 'number') return {};
  if (options.forceLegacyMaxTokens) return { max_tokens: maxTokens };
  return isGpt5Model(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function normalizeReasoningEffort(reasoningEffort) {
  const candidate = typeof reasoningEffort === 'string' ? reasoningEffort.trim().toLowerCase() : '';
  if (candidate === 'minimal') return 'none';
  if (candidate === 'x-high' || candidate === 'x_high' || candidate === 'x high') return 'xhigh';
  if (['none', 'low', 'medium', 'high', 'xhigh'].includes(candidate)) return candidate;
  return null;
}

function buildReasoningPayload(model, reasoningEffort) {
  if (!isGpt5Model(model)) return {};
  const effort = normalizeReasoningEffort(reasoningEffort);
  return effort ? { reasoning: { effort } } : {};
}

function buildResponsesTokenPayload(maxTokens) {
  if (!maxTokens || typeof maxTokens !== 'number') return {};
  return { max_output_tokens: maxTokens };
}

function buildTemperaturePayload(model, temperature) {
  if (typeof temperature !== 'number') return {};
  // GPT-5 family currently rejects custom sampling controls.
  if (isGpt5Model(model)) return {};
  return { temperature };
}

function normalizeResponsesRole(role) {
  if (role === 'assistant' || role === 'system' || role === 'developer') return role;
  return 'user';
}

function normalizeResponsesContentPart(part) {
  if (typeof part === 'string') {
    return { type: 'input_text', text: part };
  }
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'text' && typeof part.text === 'string') {
    return { type: 'input_text', text: part.text };
  }
  if (part.type === 'input_text' && typeof part.text === 'string') {
    return { type: 'input_text', text: part.text };
  }

  if (part.type === 'image_url') {
    const imageUrl = typeof part.image_url === 'string'
      ? part.image_url
      : part.image_url?.url;
    if (typeof imageUrl === 'string' && imageUrl.length > 0) {
      return { type: 'input_image', image_url: imageUrl };
    }
  }
  if (part.type === 'input_image' && typeof part.image_url === 'string') {
    return { type: 'input_image', image_url: part.image_url };
  }

  return null;
}

function convertMessagesToResponsesInput(model, messages) {
  const normalizedMessages = normalizeMessagesForModel(model, messages);
  return normalizedMessages
    .filter((message) => message && typeof message === 'object')
    .map((message) => {
      const rawContent = message.content;
      const contentArray = Array.isArray(rawContent) ? rawContent : [rawContent];
      const content = contentArray
        .map(normalizeResponsesContentPart)
        .filter(Boolean);

      if (content.length === 0) {
        content.push({ type: 'input_text', text: '' });
      }

      return {
        role: normalizeResponsesRole(message.role),
        content
      };
    });
}

function extractAssistantContentFromResponses(responseLike) {
  if (!responseLike || typeof responseLike !== 'object') return '';

  if (typeof responseLike.output_text === 'string') {
    return responseLike.output_text.trim();
  }

  if (Array.isArray(responseLike.output_text)) {
    return responseLike.output_text
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
  }

  const output = Array.isArray(responseLike.output) ? responseLike.output : [];
  const text = output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.text && typeof part.text.value === 'string') return part.text.value;
      return '';
    })
    .join('')
    .trim();

  if (text) return text;
  return extractAssistantContent(responseLike);
}

function extractTextContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.delta === 'string') return part.delta;
      if (part.text && typeof part.text.value === 'string') return part.text.value;
      return '';
    })
    .join('');

  return text.trim();
}

function extractAssistantContent(responseLike) {
  return extractTextContent(responseLike?.choices?.[0]?.message?.content);
}

async function createApiError(response, label) {
  let details = '';
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        details = parsed?.error?.message || text;
      } catch {
        details = text;
      }
    }
  } catch {
    details = '';
  }

  const suffix = details ? ` - ${details}` : '';
  return new Error(`${label} API error: ${response.status} ${response.statusText}${suffix}`);
}


class OpenAIProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string' || !key.startsWith('sk-')) {
            return { success: false, error: 'Invalid OpenAI API key format.' };
        }

        try {
            const response = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (response.ok) {
                return { success: true };
            } else {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error?.message || `Validation failed with status: ${response.status}`;
                return { success: false, error: message };
            }
        } catch (error) {
            console.error(`[OpenAIProvider] Network error during key validation:`, error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}


/**
 * Creates an OpenAI STT session
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.language='en'] - Language code
 * @param {object} [opts.callbacks] - Event callbacks
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {Promise<object>} STT session
 */
async function createSTT({ apiKey, language = 'en', callbacks = {}, usePortkey = false, portkeyVirtualKey, ...config }) {
  const keyType = usePortkey ? 'vKey' : 'apiKey';
  const key = usePortkey ? (portkeyVirtualKey || apiKey) : apiKey;
  const transcriptionModel = typeof config.model === 'string' && config.model.trim()
    ? config.model.trim()
    : 'gpt-4o-mini-transcribe';

  const wsUrl = keyType === 'apiKey'
    ? 'wss://api.openai.com/v1/realtime?intent=transcription'
    : 'wss://api.portkey.ai/v1/realtime?intent=transcription';

  const headers = keyType === 'apiKey'
    ? {
        'Authorization': `Bearer ${key}`,
        'OpenAI-Beta': 'realtime=v1',
      }
    : {
        'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
        'x-portkey-virtual-key': key,
        'OpenAI-Beta': 'realtime=v1',
      };

  const ws = new WebSocket(wsUrl, { headers });

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      console.log("WebSocket session opened.");

      const sessionConfig = {
        type: 'transcription_session.update',
        session: {
          input_audio_format: 'pcm16',
          input_audio_transcription: {
            model: transcriptionModel,
            prompt: config.prompt || '',
            language: language || 'en'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 200,
            silence_duration_ms: 100,
          },
          input_audio_noise_reduction: {
            type: 'near_field'
          }
        }
      };
      
      ws.send(JSON.stringify(sessionConfig));

      // Helper to periodically keep the websocket alive
      const keepAlive = () => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            // The ws library supports native ping frames which are ideal for heart-beats
            ws.ping();
          }
        } catch (err) {
          console.error('[OpenAI STT] keepAlive error:', err.message);
        }
      };

      resolve({
        sendRealtimeInput: (audioData) => {
          if (ws.readyState === WebSocket.OPEN) {
            const message = {
              type: 'input_audio_buffer.append',
              audio: audioData
            };
            ws.send(JSON.stringify(message));
          }
        },
        // Expose keepAlive so higher-level services can schedule heart-beats
        keepAlive,
        close: () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'session.close' }));
            ws.onmessage = ws.onerror = () => {};  // 핸들러 제거
            ws.close(1000, 'Client initiated close.');
          }
        }
      });
    };

    ws.onmessage = (event) => {
      // ── 종료·하트비트 패킷 필터링 ──────────────────────────────
      if (!event.data || event.data === 'null' || event.data === '[DONE]') return;

      let msg;
      try { msg = JSON.parse(event.data); }
      catch { return; }                       // JSON 파싱 실패 무시

      if (!msg || typeof msg !== 'object') return;

      msg.provider = 'openai';                // ← 항상 명시
      callbacks.onmessage?.(msg);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error.message);
      if (callbacks && callbacks.onerror) {
        callbacks.onerror(error);
      }
      reject(error);
    };

    ws.onclose = (event) => {
      console.log(`WebSocket closed: ${event.code} ${event.reason}`);
      if (callbacks && callbacks.onclose) {
        callbacks.onclose(event);
      }
    };
  });
}

/**
 * Creates an OpenAI LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.model='gpt-4.1'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=2048] - Max tokens
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {object} LLM instance
 */
function createLLM({ apiKey, model = 'gpt-4.1', temperature = 0.7, maxTokens = 2048, usePortkey = false, portkeyVirtualKey, reasoningEffort, ...config }) {
  const callApi = async (messages) => {
    const reasoningPayload = buildReasoningPayload(model, reasoningEffort);
    const temperaturePayload = buildTemperaturePayload(model, temperature);

    if (!usePortkey) {
      const responsesInput = convertMessagesToResponsesInput(model, messages);
      const tokenPayload = buildResponsesTokenPayload(maxTokens);

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: responsesInput,
          ...temperaturePayload,
          ...tokenPayload,
          ...reasoningPayload
        }),
      });

      if (!response.ok) {
        throw await createApiError(response, 'OpenAI');
      }

      const result = await response.json();
      return {
        content: extractAssistantContentFromResponses(result),
        raw: result
      };
    }

    const normalizedMessages = normalizeMessagesForModel(model, messages);
    const tokenPayload = buildTokenPayload(model, maxTokens, { forceLegacyMaxTokens: true });
    const response = await fetch('https://api.portkey.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
        'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: normalizedMessages,
        ...temperaturePayload,
        ...tokenPayload,
      }),
    });

    if (!response.ok) {
      throw await createApiError(response, 'Portkey');
    }

    const result = await response.json();
    return {
      content: extractAssistantContent(result),
      raw: result
    };
  };

  return {
    generateContent: async (parts) => {
      const messages = [];
      let systemPrompt = '';
      let userContent = [];
      
      for (const part of parts) {
        if (typeof part === 'string') {
          if (systemPrompt === '' && part.includes('You are')) {
            systemPrompt = part;
          } else {
            userContent.push({ type: 'text', text: part });
          }
        } else if (part.inlineData) {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
          });
        }
      }
      
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      if (userContent.length > 0) messages.push({ role: 'user', content: userContent });
      
      const result = await callApi(messages);

      return {
        response: {
          text: () => result.content
        },
        raw: result.raw
      };
    },
    
    // For compatibility with chat-style interfaces
    chat: async (messages) => {
      return await callApi(messages);
    }
  };
}

/** 
 * Creates an OpenAI streaming LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.model='gpt-4.1'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=2048] - Max tokens
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {object} Streaming LLM instance
 */
function createStreamingLLM({ apiKey, model = 'gpt-4.1', temperature = 0.7, maxTokens = 2048, usePortkey = false, portkeyVirtualKey, reasoningEffort, ...config }) {
  return {
    streamChat: async (messages) => {
      const reasoningPayload = buildReasoningPayload(model, reasoningEffort);
      const temperaturePayload = buildTemperaturePayload(model, temperature);
      if (!usePortkey) {
        const responsesInput = convertMessagesToResponsesInput(model, messages);
        const tokenPayload = buildResponsesTokenPayload(maxTokens);

        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: responsesInput,
            ...temperaturePayload,
            ...tokenPayload,
            ...reasoningPayload,
            stream: true,
          }),
        });

        if (!response.ok) {
          throw await createApiError(response, 'OpenAI');
        }

        return response;
      }

      const normalizedMessages = normalizeMessagesForModel(model, messages);
      const tokenPayload = buildTokenPayload(model, maxTokens, { forceLegacyMaxTokens: true });
      const response = await fetch('https://api.portkey.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
          'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: normalizedMessages,
          ...temperaturePayload,
          ...tokenPayload,
          stream: true,
        }),
      });

      if (!response.ok) {
        throw await createApiError(response, 'Portkey');
      }

      return response;
    }
  };
}

module.exports = {
    OpenAIProvider,
    createSTT,
    createLLM,
    createStreamingLLM
}; 
