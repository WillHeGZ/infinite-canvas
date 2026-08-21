import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { AiTextMessage } from "./image";
import type { VideoGenerationResult, VideoGenerationTask, VideoGenerationTaskState } from "./video";
import type { ReferenceImage } from "@/types/image";

// Self-contained Agnes AI adapter for channels with apiFormat === "agnes".
// image.ts / video.ts / audio.ts only dispatch here; all Agnes-specific request
// and response handling lives in this module. Type imports from ./image and
// ./video are compile-time only, keeping runtime dependencies one-directional.

type RequestOptions = { signal?: AbortSignal };

/** Video polling cadence for Agnes tasks (generation is slow; be gentle with /agnesapi). */
export const AGNES_VIDEO_POLL = { intervalMs: 60000, maxAttempts: 240 };

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

type AgnesImageResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type AgnesVideoResponse = {
    id?: string;
    task_id?: string;
    video_id?: string;
    status?: string;
    error?: { message?: string };
    url?: string;
    result_url?: string;
    video_url?: string;
    content?: { video_url?: string; url?: string } | null;
    metadata?: { url?: string } | null;
};

type AgnesApiVideoResponse =
    | AgnesVideoResponse
    | { code?: number | string; data?: AgnesVideoResponse | null; msg?: string; message?: string; error?: { message?: string } };

function agnesApiUrl(config: Pick<AiConfig, "baseUrl">, path: string) {
    if (import.meta.env.DEV) return `/api/ai/v1${path}`;
    const base = config.baseUrl.trim().replace(/\/+$/, "");
    return `${/\/v1$/i.test(base) ? base : `${base}/v1`}${path}`;
}

function agnesPollUrl(baseUrl: string, videoId: string) {
    const query = `?video_id=${encodeURIComponent(videoId)}`;
    if (import.meta.env.DEV) return `/api/ai/agnesapi${query}`;
    const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${root}/agnesapi${query}`;
}

function agnesHeaders(config: Pick<AiConfig, "apiKey">, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function withAgnesSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function withAgnesSystemMessage(config: AiConfig, messages: AiTextMessage[]): AiTextMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

/** Agnes normalizes sizes server-side; map quality + ratio (or explicit WxH) to a pixel size. */
const AGNES_QUALITY_EDGE: Record<string, number> = { low: 1024, medium: 2048, high: 2880, standard: 1024, hd: 2048 };

function resolveAgnesSize(quality: string, size: string) {
    const value = (size || "").trim();
    if (/^\d+x\d+$/i.test(value)) return value;
    if (!value || value.toLowerCase() === "auto") return "1024x1024";
    const parts = value.split(":");
    if (parts.length !== 2) return "1024x1024";
    const rw = Number(parts[0]);
    const rh = Number(parts[1]);
    if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) return "1024x1024";
    const base = AGNES_QUALITY_EDGE[quality.trim().toLowerCase()] || 2048;
    const longRatio = Math.max(rw, rh) / Math.min(rw, rh);
    const longSide = Math.max(256, Math.round(Math.sqrt(base * base * longRatio) / 16) * 16);
    const shortSide = Math.max(256, Math.round(longSide / longRatio / 16) * 16);
    return rw >= rh ? `${longSide}x${shortSide}` : `${shortSide}x${longSide}`;
}

async function compressAgnesReference(dataUrl: string, maxEdge: number): Promise<string> {
    try {
        const { width, height } = await readImageMeta(dataUrl);
        if (width <= maxEdge && height <= maxEdge) return dataUrl;
        const scale = Math.min(maxEdge / width, maxEdge / height);
        const newWidth = Math.max(1, Math.round(width * scale));
        const newHeight = Math.max(1, Math.round(height * scale));
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("image load failed"));
            img.src = dataUrl;
        });
        const canvas = document.createElement("canvas");
        canvas.width = newWidth;
        canvas.height = newHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return dataUrl;
        ctx.drawImage(img, 0, 0, newWidth, newHeight);
        return canvas.toDataURL("image/jpeg", 0.85);
    } catch {
        return dataUrl;
    }
}

function isAgnesBusyError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    if (error.response?.status === 503) return true;
    const data = error.response?.data;
    const message = typeof data === "string" ? data : data?.detail || data?.error?.message || data?.message || "";
    return /service\s*busy|server\s*is\s*busy|service\s*unavailable|服务.*忙|服务.*不可用|503/i.test(String(message));
}

function isAgnesRateLimitError(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) return true;
        const data = error.response?.data;
        const message = String(data?.msg || data?.message || "");
        return message.includes("rate limit") || message.includes("限流") || message.includes("exceeded");
    }
    return false;
}

function parseAgnesImagePayload(payload: AgnesImageResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("requestFailed"));
    const images = (payload.data || [])
        .map((item) => {
            if (typeof item.b64_json === "string" && item.b64_json) return `data:image/png;base64,${item.b64_json}`;
            if (typeof item.url === "string" && item.url) return item.url;
            return null;
        })
        .filter((value): value is string => Boolean(value))
        .map((dataUrl) => ({ id: nanoid(), dataUrl }));
    if (!images.length) throw new Error(apiText("noImageReturned"));
    return images;
}

function unwrapAgnesEnvelope(payload: AgnesApiVideoResponse, emptyMessage: string): AgnesVideoResponse {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        const envelope = payload as { code?: number | string; data?: AgnesVideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
        if (envelope.code !== 0 && envelope.code !== "0") throw new Error(envelope.msg || envelope.message || envelope.error?.message || apiText("requestFailed"));
        if (!envelope.data) throw new Error(emptyMessage);
        return envelope.data;
    }
    return payload as AgnesVideoResponse;
}

function agnesVideoResultUrl(payload: AgnesVideoResponse) {
    return [payload.metadata?.url, payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find(
        (url) => typeof url === "string" && /^https?:\/\//i.test(url),
    );
}

async function agnesVideoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        if (!response.data.type.includes("json")) return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
    }
    return { url, mimeType: "video/mp4" };
}

function agnesEventErrorMessage(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const record = value as { msg?: unknown; message?: unknown; error?: unknown };
    if (typeof record.msg === "string" && record.msg) return record.msg;
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.error === "string" && record.error) return record.error;
    if (record.error && typeof record.error === "object") {
        const message = (record.error as { message?: unknown }).message;
        if (typeof message === "string" && message) return message;
    }
    return "";
}

function agnesStatusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function readAgnesFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return agnesStatusMessage(response.status, fallback);
    try {
        return agnesEventErrorMessage(JSON.parse(text)) || agnesStatusMessage(response.status, fallback);
    } catch {
        return text.slice(0, 300) || agnesStatusMessage(response.status, fallback);
    }
}

function readAgnesError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("corsRequired");
        const message = agnesEventErrorMessage(error.response?.data);
        if (message) return message;
        return agnesStatusMessage(error.response?.status, fallback) || error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? error.message : fallback;
}

// The Agnes gateway queues concurrent generations per key; a second parallel request
// hangs until the first finishes (and the browser shows endless spinners). Route all
// Agnes image generations through a module-level serial queue so batch requests run
// one after another and each resolves as soon as its image is ready.
let agnesImageQueue: Promise<unknown> = Promise.resolve();

function enqueueAgnesImage<T>(task: () => Promise<T>): Promise<T> {
    const run = agnesImageQueue.then(task, task);
    agnesImageQueue = run.catch(() => undefined);
    return run;
}

export async function requestAgnesImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const results = await Promise.all(Array.from({ length: count }, () => enqueueAgnesImage(() => requestAgnesImagesOnce(config, prompt, references, options))));
    return results.flat();
}

async function requestAgnesImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withAgnesSystemPrompt(config, prompt),
        size: resolveAgnesSize(config.quality, config.size),
    };
    if (references.length > 0) {
        const images = await Promise.all(references.map((image) => imageToDataUrl(image)));
        const dataUrls = images.filter((value) => value.startsWith("data:"));
        const failedCount = images.length - dataUrls.length;
        if (failedCount > 0) throw new Error(apiText("agnesRefConvertFailed", { count: failedCount }));
        const compressed = await Promise.all(dataUrls.map((dataUrl) => compressAgnesReference(dataUrl, 1024)));
        body.extra_body = {
            image: compressed.map((dataUrl) => dataUrl.split(",")[1]),
            response_format: "url",
        };
    }
    const maxAttempts = 2;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const response = await axios.post<AgnesImageResponse>(agnesApiUrl(config, "/images/generations"), body, {
                headers: agnesHeaders(config, "application/json"),
                signal: options?.signal,
                timeout: 90000,
                maxBodyLength: 50 * 1024 * 1024,
                maxContentLength: 50 * 1024 * 1024,
            });
            return parseAgnesImagePayload(response.data);
        } catch (error) {
            lastError = error;
            if (!isAgnesBusyError(error) || attempt === maxAttempts) throw error;
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }
    throw lastError instanceof Error ? lastError : new Error(apiText("requestFailed"));
}

/** Agnes has no /responses endpoint; text chat (image question) goes through /chat/completions streaming. */
export async function requestAgnesChatCompletion(config: AiConfig, messages: AiTextMessage[], onDelta?: (text: string) => void, options?: RequestOptions): Promise<string> {
    const chatMessages = withAgnesSystemMessage(config, messages).map((message) => ({
        role: message.role,
        content: message.content,
    }));
    const response = await fetch(agnesApiUrl(config, "/chat/completions"), {
        method: "POST",
        headers: { ...agnesHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ model: config.model, messages: chatMessages, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readAgnesFetchError(response, apiText("requestFailed")));
    if (!response.body) {
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
        if (payload.error?.message) throw new Error(payload.error.message);
        return payload.choices?.[0]?.message?.content || "";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
            const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n")
                .trim();
            if (!data || data === "[DONE]") continue;
            try {
                const event = JSON.parse(data) as Record<string, unknown>;
                const errorMessage = agnesEventErrorMessage(event);
                if (errorMessage) throw new Error(errorMessage);
                const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
                const delta = choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta) {
                    text += delta;
                    onDelta?.(text);
                }
            } catch (error) {
                if (error instanceof Error && error.message) throw error;
            }
        }
    }
    return text;
}

function agnesVideoBaseSize(vquality: string) {
    const value = (vquality || "").trim().toLowerCase();
    if (value === "480p" || value === "low") return 480;
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return 720;
    return Number(value.replace(/p$/i, "")) || 720;
}

function normalizeAgnesVideoResolution(size: string, vquality: string) {
    const baseSize = agnesVideoBaseSize(vquality);
    const value = (size || "").trim();
    const dims = value.match(/^(\d+)x(\d+)$/i);
    if (dims) {
        const w = Number(dims[1]);
        const h = Number(dims[2]);
        if (w > 0 && h > 0) {
            if (h > w) return { width: Math.round((baseSize * 9) / 16), height: baseSize };
            if (w === h) return { width: baseSize, height: baseSize };
            return { width: Math.round((baseSize * 16) / 9), height: baseSize };
        }
    }
    if (value === "9:16" || value === "2:3" || value === "3:4") return { width: Math.round((baseSize * 9) / 16), height: baseSize };
    if (value === "1:1") return { width: baseSize, height: baseSize };
    return { width: Math.round((baseSize * 16) / 9), height: baseSize };
}

/** Agnes requires num_frames ≤ 441 and congruent to 1 (mod 8). */
function normalizeAgnesNumFrames(seconds: string) {
    const sec = Math.max(1, Math.min(20, Math.floor(Number(seconds) || 6)));
    const numFrames = Math.floor(sec * 24);
    return Math.min(441, Math.floor((numFrames - 1) / 8) * 8 + 1);
}

export async function createAgnesVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const { width, height } = normalizeAgnesVideoResolution(config.size, config.vquality);
    const payload: Record<string, unknown> = {
        model: modelOptionName(model),
        prompt,
        width,
        height,
        num_frames: normalizeAgnesNumFrames(config.videoSeconds),
        frame_rate: 24,
    };
    if (references.length > 0) {
        const imageUrls = await Promise.all(references.slice(0, 7).map((image) => imageToDataUrl(image)));
        const urls = imageUrls.filter((value) => Boolean(value));
        if (urls.length > 0) payload.image = urls;
    }
    try {
        const response = await axios.post<AgnesApiVideoResponse>(agnesApiUrl(config, "/videos"), payload, {
            headers: agnesHeaders(config, "application/json"),
            signal: options?.signal,
        });
        const created = unwrapAgnesEnvelope(response.data, apiText("noVideoTask"));
        const videoId = created.video_id || created.task_id || created.id;
        if (!videoId) throw new Error(apiText("agnesNoVideoTaskId"));
        return { id: created.id || videoId, provider: "agnes", model, videoId };
    } catch (error) {
        throw new Error(readAgnesError(error, apiText("videoTaskCreateFailed")));
    }
}

export async function pollAgnesVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const response = task.videoId
            ? await axios.get<AgnesApiVideoResponse>(agnesPollUrl(config.baseUrl, task.videoId), { headers: agnesHeaders(config), signal: options?.signal })
            : await axios.get<AgnesApiVideoResponse>(agnesApiUrl(config, `/videos/${task.id}`), { headers: agnesHeaders(config), signal: options?.signal });
        const video = unwrapAgnesEnvelope(response.data, apiText("noVideoTask"));
        const url = agnesVideoResultUrl(video);
        if (url) return { status: "completed", result: await agnesVideoResultFromUrl(url, options) };
        if (video.status === "completed" || video.status === "succeeded") return { status: "failed", error: apiText("agnesNoVideoUrl") };
        if (video.status === "failed" || video.status === "cancelled" || video.status === "expired") {
            return { status: "failed", error: video.error?.message || apiText("videoGenerationFailed") };
        }
        return { status: "pending" };
    } catch (error) {
        // Rate limiting is transient; keep polling instead of failing the task.
        if (isAgnesRateLimitError(error)) return { status: "pending" };
        throw new Error(readAgnesError(error, apiText("videoTaskQueryFailed")));
    }
}
