// 프롬프트는 작성한 그대로 전송
// - 실리태번의 매크로 치환({{user}} → 현재 페르소나 이름 등)을 거치지 않음
// - 현재 페르소나 설명·채팅 기록·다른 확장의 프롬프트 주입이 섞이지 않음
// - 채팅용 설정(사용자 정지 문자열, 어시스턴트 프리필, 웹 검색)은 빼고 보냄 — 결과가 중간에 끊기는 원인
// - 실리태번 전역 설정(페르소나 등)을 임시로 바꾸지 않음

import { extension_settings, getContext } from "../../../../extensions.js";
import { generateRaw, amount_gen } from "../../../../../script.js";
import { state, log, getSettings, cancelledError } from './state.js';

export function getConnectionProfiles() {
    const profiles = extension_settings?.connectionManager?.profiles || [];
    return profiles.map(p => ({ id: p.id, name: p.name }));
}

function positive(value) {
    const number = Number(value);
    return number > 0 ? Math.floor(number) : null;
}

// 연결 설정의 응답 길이가 채팅용으로 짧으면 프로필이 잘리므로 권장값으로 올림 (확장에서 직접 지정한 값은 그대로)
const MIN_OUTPUT_TOKENS = 5000;

function outputLimit(override, inheritedValue) {
    if (override) return { maxTokens: override, inherited: false };
    if (inheritedValue && inheritedValue < MIN_OUTPUT_TOKENS) {
        return { maxTokens: MIN_OUTPUT_TOKENS, inherited: true, raisedFrom: inheritedValue };
    }
    return { maxTokens: inheritedValue ?? null, inherited: true };
}

function resolveTarget(context, settings) {
    const override = positive(settings.maxTokens);
    const presetManager = type => context.getPresetManager?.(type);

    if (settings.connectionProfile) {
        if (context.extensionSettings?.disabledExtensions?.includes('connection-manager')) {
            throw new Error('실리태번의 Connection Manager 확장이 꺼져 있습니다. 켜거나 "현재 연결 사용"을 선택하십시오.');
        }
        const profile = (extension_settings?.connectionManager?.profiles || []).find(p => p.id === settings.connectionProfile);
        if (!profile) {
            throw new Error('선택한 연결 프로필을 찾을 수 없습니다. API 설정에서 프로필을 다시 선택하십시오.');
        }
        const mapping = context.CONNECT_API_MAP?.[profile.api];
        const label = `연결 프로필 "${profile.name}"`;

        if (mapping?.selected === 'openai' && mapping.source) {
            const preset = profile.preset ? presetManager('openai')?.getCompletionPresetByName?.(profile.preset) : null;
            const inheritedMax = positive(preset?.openai_max_tokens) ?? positive(context.chatCompletionSettings?.openai_max_tokens) ?? 4096;
            return {
                kind: 'cc', label, profile, preset: preset || {},
                source: mapping.source, model: profile.model,
                ...outputLimit(override, inheritedMax),
            };
        }
        if (mapping?.selected === 'textgenerationwebui' && mapping.type) {
            const preset = profile.preset ? presetManager('textgenerationwebui')?.getCompletionPresetByName?.(profile.preset) : null;
            const instruct = profile.instruct ? presetManager('instruct')?.getCompletionPresetByName?.(profile.instruct) : null;
            const inheritedMax = positive(preset?.genamt) ?? positive(amount_gen) ?? 1024;
            return {
                kind: 'tc', label, profile, preset: preset || {}, instruct,
                apiType: mapping.type, model: profile.model, server: profile['api-url'],
                ...outputLimit(override, inheritedMax),
            };
        }
        throw new Error(`${label}의 API 형식(${profile.api || '알 수 없음'})은 지원하지 않습니다.`);
    }

    if (context.mainApi === 'openai' && typeof context.ChatCompletionService?.presetToGeneratePayload === 'function') {
        const oai = context.chatCompletionSettings || {};
        return {
            kind: 'cc', label: `현재 연결 (${oai.chat_completion_source || 'Chat Completion'})`, preset: {},
            source: oai.chat_completion_source, model: context.getChatCompletionModel?.(oai),
            ...outputLimit(override, positive(oai.openai_max_tokens) ?? 4096),
        };
    }
    if (context.mainApi === 'textgenerationwebui' && typeof context.TextCompletionService?.presetToGeneratePayload === 'function') {
        const tc = context.textCompletionSettings || {};
        const instruct = context.powerUserSettings?.instruct;
        return {
            kind: 'tc', label: `현재 연결 (${tc.type || 'Text Completion'})`, preset: {},
            instruct: instruct?.enabled ? instruct : null,
            apiType: tc.type, server: context.getTextGenServer?.(tc.type),
            // 표시용 (요청에는 넣지 않음) — 실리태번이 연결 상태에 모델 이름을 둠
            modelLabel: typeof context.onlineStatus === 'string' && context.onlineStatus !== 'no_connection' ? context.onlineStatus : '',
            ...outputLimit(override, positive(amount_gen) ?? 1024),
        };
    }
    // KoboldAI / NovelAI / Horde 또는 구버전 실리태번
    return {
        kind: 'raw', label: `현재 연결 (${context.mainApi || '알 수 없음'})`,
        ...outputLimit(override, positive(amount_gen)),
    };
}

export function describeConnection() {
    try {
        const target = resolveTarget(getContext(), getSettings());
        return { label: target.label, maxTokens: target.maxTokens, inherited: target.inherited, raisedFrom: target.raisedFrom };
    } catch (error) {
        return { label: '', maxTokens: null, inherited: true, error: error.message };
    }
}

// connectionProfile: 이 요청만 다른 연결 프로필로 보낼 때 (대화형 서포터)
// 실리태번 서버가 자세한 이유 없이 거절할 때 보내는 응답 ({ error: true })
const GENERIC_REJECT = 'API 요청이 거절되었습니다. 자세한 이유는 실리태번 서버 창(터미널)의 로그를 확인하십시오.';

// 오류에서 보여 줄 문구 — Error가 아닌 객체(서버 응답 JSON 등)도 "[object Object]" 대신 내용으로
function errorDetail(error) {
    if (typeof error === 'string') return error;
    const message = error?.cause?.message || error?.message || error?.error?.message
        || (typeof error?.error === 'string' ? error.error : '') || error?.detail;
    if (message) return String(message);
    if (error?.error === true) return GENERIC_REJECT;
    try {
        const json = JSON.stringify(error);
        if (json && json !== '{}') return json.slice(0, 300);
    } catch { /* 문자열로 바꿀 수 없는 객체 */ }
    return String(error ?? '알 수 없는 오류');
}

export async function callGenerationAPI(messages, { signal, label = '', connectionProfile } = {}) {
    const context = getContext();
    const settings = getSettings();
    const target = resolveTarget(context, connectionProfile ? { ...settings, connectionProfile } : settings);
    target.stream = settings.streamRequests !== false;
    const startedAt = Date.now();

    state.lastRequest = {
        time: Date.now(),
        label,
        route: target.label,
        maxTokens: target.maxTokens,
        messages: structuredClone(messages),
        status: 'pending',
    };
    const record = state.lastRequest;

    let result;
    try {
        if (target.kind === 'cc') result = await sendChatCompletion(context, target, messages, signal);
        else if (target.kind === 'tc') result = await sendTextCompletion(context, target, messages, signal);
        else result = await sendViaGenerateRaw(messages, target.maxTokens);
    } catch (error) {
        record.status = 'error';
        if (signal?.aborted) throw cancelledError();
        let detail = errorDetail(error);
        // 한 번에 받는 요청이 오래 걸리면 중계 서버·게이트웨이가 연결을 끊음 (오류 문구가 "<none>" 등으로 보임)
        if (target.kind === 'cc' && !target.stream && Date.now() - startedAt >= 90000) {
            detail += ' — 응답이 오래 걸려 API 서버(중계 서버)가 연결을 끊은 것으로 보입니다. 설정 탭에서 "스트리밍으로 받기"를 켜 주십시오.';
        }
        throw new Error(target.profile ? `${target.label} 요청 실패: ${detail}` : detail);
    }

    if (signal?.aborted) throw cancelledError();
    record.status = result.truncated ? 'truncated' : 'done';
    result.model = result.model || String(target.model || target.modelLabel || '').trim();

    if (typeof result.text !== 'string' || !result.text.trim()) {
        // 사고 모델이 출력 한도를 생각하는 데 다 쓰면 본문이 비어서 옴
        if (result.truncated || result.reasoningChars > 0) {
            const limit = target.maxTokens ? `${target.maxTokens.toLocaleString()}토큰` : '출력 한도';
            throw new Error(`모델이 생각(추론)하는 데 ${limit}를 다 써서 본문을 쓰지 못했습니다. 설정 탭의 최대 출력 토큰을 크게(예: 32000) 늘리거나, 추론을 짧게 하는 프리셋·모델로 다시 시도하십시오.`);
        }
        throw new Error('API에서 빈 응답을 받았습니다. 출력 토큰 한도나 모델의 거부 여부를 확인하십시오.');
    }
    return result;
}

// 연결 확인 — 짧은 요청 하나로 응답이 오는지만 봄 (지금 고른 연결·출력 설정 그대로)
// connectionProfile: 서포터 연결을 시험할 때 (비우면 메인 연결 프로필)
export async function testConnection(signal, { connectionProfile } = {}) {
    const startedAt = Date.now();
    const result = await callGenerationAPI([
        { role: 'system', content: 'This is a connection test.' },
        { role: 'user', content: 'Reply with just "OK".' },
    ], { signal, label: '연결 테스트', connectionProfile });
    return { seconds: (Date.now() - startedAt) / 1000, reply: result.text.trim() };
}

let scriptModulePromise = null;
// Gemini 응답의 글 조각(part)들을 원래대로 이어 붙임 (추론 조각은 뺌) — Gemini 응답이 아니면 null
// 실리태번은 스트리밍이 아닐 때 조각 사이에 빈 줄을 넣고(낱말 중간에서 나뉘면 "## BAS\n\nICS"처럼 깨짐),
// 스트리밍일 때는 한 번에 온 조각 중 첫 번째만 돌려줌(나머지 글이 빠짐) — 구글 SDK처럼 구분자 없이 이어 붙임
function joinGeminiParts(parts) {
    if (!Array.isArray(parts)) return null;
    const texts = parts.filter(part => !part?.thought && typeof part?.text === 'string').map(part => part.text);
    return texts.length ? texts.join('') : null;
}

async function extractText(raw, api) {
    if (typeof raw === 'string') return raw;
    const gemini = joinGeminiParts(raw?.responseContent?.parts);
    if (gemini !== null) return gemini;
    scriptModulePromise ??= import("../../../../../script.js").catch(() => ({}));
    const script = await scriptModulePromise;
    if (typeof script.extractMessageFromData === 'function') {
        const text = script.extractMessageFromData(raw, api);
        if (typeof text === 'string') return text;
    }
    return raw?.choices?.[0]?.message?.content ?? raw?.choices?.[0]?.text ?? raw?.content ?? '';
}

// 실제로 답한 모델 이름 (OpenAI 호환: model / Claude 스트리밍: message.model / Gemini: modelVersion) — 없으면 ''
function responseModel(raw) {
    const model = raw?.model ?? raw?.message?.model ?? raw?.modelVersion;
    return typeof model === 'string' ? model.trim() : '';
}

// API가 출력 한도 때문에 멈췄다고 알려줬는지
// (OpenAI 호환 API는 알려주지만, 실리태번 서버는 Claude·Gemini 응답에서 이 정보를 빼고 전달함)
function detectTruncation(raw) {
    const reason = raw?.choices?.[0]?.finish_reason ?? raw?.stop_reason ?? raw?.candidates?.[0]?.finishReason ?? raw?.finish_reason;
    return ['length', 'max_tokens', 'MAX_TOKENS', 'model_length'].includes(String(reason));
}

let openaiModulePromise = null;
async function findProxy(name) {
    if (!name || name === 'None') return null;
    openaiModulePromise ??= import("../../../../openai.js").catch(() => ({}));
    const openai = await openaiModulePromise;
    return (openai.proxies || []).find(p => p.name === name) || null;
}

const TRUNCATION_REASONS = ['length', 'max_tokens', 'MAX_TOKENS', 'model_length'];

// 스트리밍 조각에 "출력 한도로 멈춤" 표시가 있는지
// (OpenAI 호환: finish_reason / Claude: message_delta의 stop_reason / Gemini: finishReason / Cohere: finish_reason)
function isStreamTruncation(parsed) {
    const reasons = [
        parsed?.choices?.[0]?.finish_reason,
        parsed?.delta?.stop_reason,
        parsed?.candidates?.[0]?.finishReason,
        parsed?.delta?.finish_reason,
        parsed?.stop_reason,
    ];
    return reasons.some(reason => TRUNCATION_REASONS.includes(String(reason)));
}

function streamErrorMessage(body, status) {
    try {
        const data = JSON.parse(body);
        const message = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || data?.detail;
        if (message) return String(message);
        if (data?.error === true) return GENERIC_REJECT;
    } catch { /* 본문이 JSON이 아님 */ }
    const text = String(body || '').trim();
    return text ? text.slice(0, 300) : `서버 응답 ${status}`;
}

// 스트리밍 요청을 직접 읽음 — 실리태번의 스트리밍 함수는 "출력 한도로 멈췄는지"를 알려주지 않아서
// 글자 해석은 실리태번의 getStreamingReply를 그대로 사용 (API별 형식 차이 처리)
async function streamChatCompletion(context, payload, signal) {
    openaiModulePromise ??= import("../../../../openai.js").catch(() => ({}));
    const [openai, sse] = await Promise.all([
        openaiModulePromise,
        import("../../../../sse-stream.js").catch(() => ({})),
    ]);
    const EventSourceStream = sse.default;
    if (typeof openai.getStreamingReply !== 'function' || typeof EventSourceStream !== 'function'
        || typeof context.getRequestHeaders !== 'function') {
        return null;
    }

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(payload),
        signal,
    });
    if (!response.ok) {
        throw new Error(streamErrorMessage(await response.text().catch(() => ''), response.status));
    }

    const eventStream = new EventSourceStream();
    response.body.pipeThrough(eventStream);
    const reader = eventStream.readable.getReader();
    const replyState = { reasoning: '', images: [], signature: '', toolSignatures: {} };
    let text = '';
    let truncated = false;
    let model = '';
    let gaps = 0; // 읽지 못한 응답 조각 (그 자리의 글이 빠짐)

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = value?.data;
        if (!raw || raw === '[DONE]') {
            if (raw === '[DONE]') break;
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            if (/^\s*[[{]/.test(raw)) gaps++;
            continue;
        }
        if (parsed?.error) throw new Error(streamErrorMessage(raw, response.status));
        if (isStreamTruncation(parsed)) truncated = true;
        model ||= responseModel(parsed);
        if (Array.isArray(parsed?.choices) && parsed.choices[0]?.index > 0) continue; // 여러 개를 요청한 경우의 나머지
        // 추론(thinking) 내용은 결과에 넣지 않고, 진행 표시에만 씀 (생각하는 동안 멈춘 것처럼 보이지 않게)
        const piece = openai.getStreamingReply(parsed, replyState, {
            chatCompletionSource: payload.chat_completion_source,
            overrideShowThoughts: true,
        }) || '';
        text += joinGeminiParts(parsed?.candidates?.[0]?.content?.parts) ?? piece;
        state.progressListener?.(text.length, replyState.reasoning.length);
    }
    if (gaps) log(`Stream: ${gaps} chunk(s) could not be parsed`);
    return { text, truncated, model, gaps, reasoningChars: replyState.reasoning.length };
}

// 실리태번 1.15 전에는 presetToGeneratePayload가 넘긴 메시지·연결 정보를 버리고 샘플러 값만 돌려줌
// → 현재 연결이면 예전 방식(generateRaw)으로 보냄 (실리태번 설정 그대로, 잘림 여부·모델 이름은 알 수 없음)
//   연결 프로필은 예전 방식으로 쓸 수 없어 안내 (조용히 다른 연결로 보내지 않게)
function legacyFallback(target, messages) {
    if (target.profile) {
        throw new Error('이 실리태번 버전에서는 연결 프로필로 보낼 수 없습니다. 실리태번을 1.15 이상으로 업데이트하거나, API 연결을 "현재 연결 사용"으로 바꿔 주십시오.');
    }
    return sendViaGenerateRaw(messages, target.maxTokens);
}

// Chat Completion — 실리태번 설정(모델·프록시·샘플러)은 사용하되 메시지는 가공하지 않음
async function sendChatCompletion(context, target, messages, signal) {
    const service = context.ChatCompletionService;
    const base = {
        messages: structuredClone(messages),
        chat_completion_source: target.source,
        stream: false,
        max_tokens: target.maxTokens,
    };
    if (target.model) base.model = target.model;

    // 연결 프로필 — 실리태번 Connection Manager와 같은 방식으로 연결 정보 적용
    const profile = target.profile;
    if (profile) {
        if (profile['secret-id']) base.secret_id = profile['secret-id'];
        const url = profile['api-url'];
        if (url) {
            for (const field of ['custom_url', 'vertexai_region', 'zai_endpoint', 'siliconflow_endpoint', 'minimax_endpoint', 'pollinations_endpoint']) {
                base[field] = url;
            }
        }
        if (profile['prompt-post-processing']) base.custom_prompt_post_processing = profile['prompt-post-processing'];
        const proxy = await findProxy(profile.proxy);
        if (proxy?.url) {
            base.reverse_proxy = proxy.url;
            base.proxy_password = proxy.password;
        }
    }

    log(`Sending via ${target.label}${target.stream ? ' (streaming)' : ''}`);
    const payload = await service.presetToGeneratePayload(target.preset || {}, {}, base);
    if (!Array.isArray(payload?.messages)) return legacyFallback(target, messages);

    payload.stream = !!target.stream;
    for (const key of ['stop', 'assistant_prefill', 'assistant_impersonation', 'tools', 'tool_choice', 'json_schema', 'response_format']) {
        delete payload[key];
    }
    // 실리태번이 현재 페르소나·캐릭터 이름을 함께 실어 보내는데, 프롬프트 후처리("한 메시지로 합치기" 등)에서
    // 메시지 앞에 "이름: "으로 붙을 수 있어 비움 (만드는 인물의 이름에 현재 페르소나 이름이 섞이지 않게)
    payload.user_name = '';
    payload.char_name = '';
    payload.group_names = [];
    if ('enable_web_search' in payload) payload.enable_web_search = false;
    if ('request_images' in payload) payload.request_images = false;

    // 스트리밍: 글자가 흐르는 동안 연결이 유지되어, 오래 걸리는 생성이 중간에 끊기지 않음
    if (payload.stream) {
        const streamed = await streamChatCompletion(context, payload, signal);
        if (streamed) return streamed;

        // 실리태번 내부 모듈을 못 읽는 경우: 실리태번의 스트리밍 함수 사용 (출력 한도 여부는 알 수 없음)
        const stream = await service.sendRequest(payload, true, signal);
        let text = '';
        for await (const chunk of stream()) {
            text = chunk.text || '';
            state.progressListener?.(text.length, String(chunk.state?.reasoning || '').length);
        }
        return { text, truncated: false };
    }

    const raw = await service.sendRequest(payload, false, signal);
    return { text: await extractText(raw, 'openai'), truncated: detectTruncation(raw), model: responseModel(raw) };
}

async function sendTextCompletion(context, target, messages, signal) {
    const service = context.TextCompletionService;

    let prompt;
    let instructStops = [];
    if (target.instruct && typeof service.constructPrompt === 'function') {
        prompt = service.constructPrompt(structuredClone(messages), target.instruct);
        try {
            const instructModule = await import("../../../../instruct-mode.js");
            instructStops = instructModule.getInstructStoppingSequences?.({ customInstruct: target.instruct, useStopStrings: false }) || [];
        } catch { /* 정지 문자열 없이 진행 */ }
    } else {
        prompt = messages.map(m => m.content).join('\n\n') + '\n\n';
    }

    const base = {
        prompt,
        stream: false,
        max_tokens: target.maxTokens,
        api_type: target.apiType,
    };
    if (target.server) base.api_server = target.server;
    if (target.model) base.model = target.model;
    if (target.profile?.['secret-id']) base.secret_id = target.profile['secret-id'];

    log(`Sending via ${target.label}`);
    const payload = await service.presetToGeneratePayload(target.preset || {}, {}, base);
    if (payload?.prompt == null) return legacyFallback(target, messages);
    payload.stream = false;
    // 채팅용 정지 문자열("\n캐릭터이름:" 등)은 프로필의 대사 예시에서 출력을 끊으므로 인스트럭트 끝 표시만 사용
    payload.stopping_strings = instructStops;
    payload.stop = instructStops;

    const raw = await service.sendRequest(payload, false, signal);
    let text = await extractText(raw, 'textgenerationwebui');
    for (const stop of instructStops) {
        if (stop && text.endsWith(stop)) text = text.slice(0, -stop.length);
    }
    return { text, truncated: detectTruncation(raw), model: responseModel(raw) };
}

// 기타 API 폴백 — 이 경로는 실리태번이 매크로를 치환하므로
// {{user}}를 중립 표기로 바꿔 현재 페르소나 이름·설명이 섞이지 않게 함
async function sendViaGenerateRaw(messages, maxTokens) {
    const protect = text => String(text)
        .replace(/\{\{user\}\}/gi, '[user]')
        .replace(/\{\{persona\}\}/gi, '');
    const [system, ...rest] = messages;

    log('Using generateRaw fallback');
    // 1.14 전: generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength) — prompt는 글자만
    if (generateRaw.length >= 2) {
        const prompt = rest.map(m => protect(m.content)).join('\n\n');
        const result = await generateRaw(prompt, null, false, false, protect(system.content), maxTokens || null);
        return { text: result || '', truncated: false };
    }
    // Chat Completion은 user 역할 그대로, Text Completion은 이름("페르소나:")이 붙지 않게 system으로
    const isChat = getContext()?.mainApi === 'openai';
    const role = m => (m.role === 'assistant' ? 'assistant' : (isChat && m.role === 'user' ? 'user' : 'system'));
    const result = await generateRaw({
        systemPrompt: protect(system.content),
        prompt: rest.map(m => ({ role: role(m), content: protect(m.content) })),
        responseLength: maxTokens || null,
    });
    return { text: result || '', truncated: false };
}
