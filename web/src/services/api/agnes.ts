import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { AiTextMessage } from "./image";
import type { VideoGenerationResult, VideoGenerationTask, VideoGenerationTaskState } from "./video";
import type { ReferenceAudio } from "@/types/media";
import type { ReferenceImage } from "@/types/image";

// Self-contained Agnes AI adapter for channels with apiFormat === "agnes".
// image.ts / video.ts / audio.ts only dispatch here; all Agnes-specific request
// and response handling lives in this module. Type imports from ./image and
// ./video are compile-time only, keeping runtime dependencies one-directional.

type RequestOptions = { signal?: AbortSignal };

/** Agnes video model generation: v2.5 exposes the multimodal reference API, v2.0 only keyframes. */
export function isAgnesVideo25Model(model: string) {
    return /video/i.test(model) && /2\.5/.test(model);
}

/** Flash video models (e.g. agnes-video-2.5-flash): same body as 2.5 but max 5 reference images and model_name required when polling. */
export function isAgnesVideoFlashModel(model: string) {
    return /video/i.test(model) && /flash/i.test(model);
}

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

function agnesPollUrl(baseUrl: string, videoId: string, modelName?: string) {
    // Flash models reject a bare video_id lookup for keyframe/reference tasks; model_name is required.
    const query = `?video_id=${encodeURIComponent(videoId)}${modelName ? `&model_name=${encodeURIComponent(modelName)}` : ""}`;
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

/**
 * Agnes image tier whitelist. The gateway assigns the rate-limit tier from `size`; custom pixel
 * sizes (e.g. 2736x1536) get bucketed server-side and can silently land in a stricter tier
 * (3K = 1 request/minute). Always send an explicit tier + ratio so the bucket is deterministic.
 * Official 2K + 16:9 → 2624x1472; 3K + 1:1 → 3072x3072; 4K + 9:16 → 2944x5248, etc.
 */
type AgnesImageTier = "1K" | "2K" | "3K" | "4K";

function agnesTierFromLongEdge(longEdge: number): AgnesImageTier {
    if (longEdge <= 1024) return "1K";
    if (longEdge <= 2048) return "2K";
    if (longEdge <= 3072) return "3K";
    return "4K";
}

/** Request-body tier: explicit WxH keeps its bucket by long edge (preserves "9:16(4k)" etc.), otherwise quality maps low→1K / auto·medium→2K / high→3K. */
function resolveAgnesImageTier(quality: string, size: string): AgnesImageTier {
    const dims = (size || "").trim().match(/^(\d+)x(\d+)$/i);
    if (dims && Number(dims[1]) > 0 && Number(dims[2]) > 0) return agnesTierFromLongEdge(Math.max(Number(dims[1]), Number(dims[2])));
    const value = (quality || "").trim().toLowerCase();
    if (value === "low" || value === "standard") return "1K";
    if (value === "high") return "3K";
    if (value === "medium" || value === "hd") return "2K";
    if (/^\d+$/.test(value)) return agnesTierFromLongEdge(Number(value));
    return "2K";
}

/** Request-body ratio: snap the configured size (WxH or "w:h") onto the official 8-value whitelist; "auto"/empty → official default "1:1". */
function resolveAgnesImageRatio(size: string) {
    const value = (size || "").trim();
    let ratio = 1;
    const dims = value.match(/^(\d+)x(\d+)$/i);
    const pair = value.match(/^(\d+(?:\.\d+)?)[::](\d+(?:\.\d+)?)$/);
    if (dims && Number(dims[1]) > 0 && Number(dims[2]) > 0) ratio = Number(dims[1]) / Number(dims[2]);
    else if (pair && Number(pair[1]) > 0 && Number(pair[2]) > 0) ratio = Number(pair[1]) / Number(pair[2]);
    let best = AGNES_IMAGE_ASPECT_RATIOS[0];
    for (const entry of AGNES_IMAGE_ASPECT_RATIOS) {
        if (Math.abs(entry[0] - ratio) < Math.abs(best[0] - ratio)) best = entry;
    }
    return best[1];
}

const AGNES_IMAGE_ASPECT_RATIOS: Array<[number, string]> = [
    [21 / 9, "21:9"],
    [16 / 9, "16:9"],
    [3 / 2, "3:2"],
    [4 / 3, "4:3"],
    [1, "1:1"],
    [3 / 4, "3:4"],
    [2 / 3, "2:3"],
    [9 / 16, "9:16"],
];

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
    if (!axios.isAxiosError(error)) return false;
    if (error.response?.status === 429) return true;
    const data = error.response?.data;
    if (typeof data === "string") return /rate\s*limit|限流/i.test(data);
    const message = String(data?.msg || data?.message || data?.error?.message || error.message || "");
    const code = String(data?.code || data?.error?.code || "");
    return code === "rate_limit_exceeded" || /rate\s*limit|rate_limit|限流/i.test(message);
}

/** Parse the retry wait from a rate-limit message ("3K tier allows 1 requests per 1 minute(s)" → 61s); default 61s. */
function agnesRateLimitWaitMs(error: unknown): number {
    const data = axios.isAxiosError(error) ? error.response?.data : null;
    const message = String((typeof data === "string" ? data : data?.error?.message || data?.msg || data?.message) || "");
    const minutes = message.match(/per\s+(\d+)\s*minute/i);
    if (minutes) return Number(minutes[1]) * 60_000 + 1_000;
    const seconds = message.match(/(?:per|after|in)\s+(\d+)\s*second/i);
    if (seconds) return Number(seconds[1]) * 1_000 + 1_000;
    return 61_000;
}

/** Abort-aware delay: rejects immediately with AbortError once the caller cancels generation. */
function agnesDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
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
        size: resolveAgnesImageTier(config.quality, config.size),
        ratio: resolveAgnesImageRatio(config.size),
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
    // Tiers like 3K/4K allow ~1 request per minute; retry across the rate-limit window (6 attempts
    // covers a 3-image batch on a 1 RPM tier) and abort immediately when the user cancels.
    const maxAttempts = 6;
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
            const rateLimited = isAgnesRateLimitError(error);
            if ((!rateLimited && !isAgnesBusyError(error)) || attempt === maxAttempts) throw error;
            await agnesDelay(rateLimited ? agnesRateLimitWaitMs(error) : 3000, options?.signal);
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

/**
 * Mirror the video panel's normalizeVideoSizeValue so the wire ratio matches what the user saw:
 * portrait ratios → 720x1280, everything else (incl. "1:1", "auto") → 1280x720.
 * Cannot import the panel helper (the panel imports this module); keep this in sync with it.
 */
function agnesVideoSizeValue(size: string) {
    const value = (size || "").trim();
    if (/^\d+x\d+$/i.test(value)) return value;
    if (["9:16", "2:3", "3:4"].includes(value)) return "720x1280";
    return "1280x720";
}

function normalizeAgnesVideoResolution(size: string, vquality: string) {
    const baseSize = agnesVideoBaseSize(vquality);
    const dims = agnesVideoSizeValue(size).match(/^(\d+)x(\d+)$/i);
    const w = Number(dims?.[1]) || 1280;
    const h = Number(dims?.[2]) || 720;
    if (h > w) return { width: Math.round((baseSize * 9) / 16), height: baseSize };
    if (w === h) return { width: baseSize, height: baseSize };
    return { width: Math.round((baseSize * 16) / 9), height: baseSize };
}

/** Agnes requires num_frames ≤ 441 and congruent to 1 (mod 8). */
function normalizeAgnesNumFrames(seconds: string) {
    const sec = Math.max(1, Math.min(20, Math.floor(Number(seconds) || 6)));
    const numFrames = Math.floor(sec * 24);
    return Math.min(441, Math.floor((numFrames - 1) / 8) * 8 + 1);
}

function blobToAgnesDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("blob read failed"));
        reader.readAsDataURL(blob);
    });
}

/** Convert an audio reference (IndexedDB / blob: / remote URL) to a data URL the Agnes gateway accepts. */
async function audioRefToDataUrl(audio: { url?: string; storageKey?: string }): Promise<string> {
    if (audio.storageKey) {
        const blob = await getMediaBlob(audio.storageKey);
        if (blob) return blobToAgnesDataUrl(blob);
    }
    if (audio.url?.startsWith("data:")) return audio.url;
    if (audio.url?.startsWith("blob:")) return blobToAgnesDataUrl(await (await fetch(audio.url)).blob());
    if (audio.url && /^https?:\/\//i.test(audio.url)) return audio.url;
    return "";
}

type AgnesVideoMode = "text" | "keyframe" | "reference";

/**
 * Effective Agnes video mode:
 * - no reference media at all → text (both UI modes fall back to text-to-video)
 * - v2.0 models → keyframe only (the reference API does not exist on v2.0)
 * - v2.5 models → the selected mode (default "reference")
 */
function resolveAgnesVideoMode(model: string, videoMode: string, hasMedia: boolean): AgnesVideoMode {
    if (!hasMedia) return "text";
    if (!isAgnesVideo25Model(model)) return "keyframe";
    return videoMode === "keyframe" ? "keyframe" : "reference";
}

const AGNES_VIDEO_ASPECT_RATIOS: Array<[number, string]> = [
    [21 / 9, "21:9"],
    [16 / 9, "16:9"],
    [4 / 3, "4:3"],
    [1, "1:1"],
    [3 / 4, "3:4"],
    [9 / 16, "9:16"],
];

/** Map the configured size (WxH or ratio) onto the v2.5 aspect_ratio whitelist, normalizing first so the sent ratio matches the panel display. */
function agnesV25AspectRatio(size: string) {
    const dims = agnesVideoSizeValue(size).match(/^(\d+)x(\d+)$/i);
    const ratio = dims && Number(dims[1]) > 0 && Number(dims[2]) > 0 ? Number(dims[1]) / Number(dims[2]) : 16 / 9;
    let best = AGNES_VIDEO_ASPECT_RATIOS[0];
    for (const entry of AGNES_VIDEO_ASPECT_RATIOS) {
        if (Math.abs(entry[0] - ratio) < Math.abs(best[0] - ratio)) best = entry;
    }
    return best[1];
}

/** v2.5 body: mode + seconds(4-12) + size "720P" + aspect_ratio whitelist; never sends v2.0-style fields (400). */
function buildAgnesV25Body(config: AiConfig, model: string, prompt: string, videoMode: string, images: string[], audios: string[]) {
    const mode = resolveAgnesVideoMode(model, videoMode, images.length > 0 || audios.length > 0);
    const seconds = String(Math.max(4, Math.min(12, Math.floor(Number(config.videoSeconds) || 5))));
    const body: Record<string, unknown> = { model, prompt, mode, seconds, size: "720P", aspect_ratio: agnesV25AspectRatio(config.size) };
    if (mode === "keyframe") {
        if (images[0]) body.first_frame = images[0];
        if (images[1]) body.last_frame = images[1];
    } else if (mode === "reference") {
        if (images.length > 0) body.images = images;
        if (audios.length > 0) body.audios = audios;
    }
    return body;
}

/** v2.0 body: width/height/num_frames; 2 images → extra_body keyframes, 1 image → top-level image, 0 → pure text. */
function buildAgnesV20Body(config: AiConfig, model: string, prompt: string, images: string[]) {
    const { width, height } = normalizeAgnesVideoResolution(config.size, config.vquality);
    const body: Record<string, unknown> = {
        model,
        prompt,
        width,
        height,
        num_frames: normalizeAgnesNumFrames(config.videoSeconds),
        frame_rate: 24,
    };
    if (images.length >= 2) body.extra_body = { image: images.slice(0, 2), mode: "keyframes" };
    else if (images.length === 1) body.image = images[0];
    return body;
}

export async function createAgnesVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions, audioReferences: ReferenceAudio[] = []): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const flash = isAgnesVideoFlashModel(modelName);
    const v25 = isAgnesVideo25Model(modelName);
    const maxReferenceImages = v25 ? (flash ? 5 : 7) : 2;
    const imageUrls = await Promise.all(references.map((image) => imageToDataUrl(image).catch(() => "")));
    const images = imageUrls.filter((value) => Boolean(value)).slice(0, v25 && config.videoMode !== "keyframe" ? maxReferenceImages : 2);
    const audios = (await Promise.all(audioReferences.slice(0, 5).map((audio) => audioRefToDataUrl(audio).catch(() => "")))).filter((value) => Boolean(value));
    if (v25 && config.videoMode === "keyframe" && references.length > 2) throw new Error(apiText("agnesKeyframeLimit"));
    if (flash && config.videoMode !== "keyframe" && references.length > maxReferenceImages) throw new Error(apiText("agnesFlashImageLimit"));
    const payload = v25 ? buildAgnesV25Body(config, modelName, prompt, config.videoMode, images, audios) : buildAgnesV20Body(config, modelName, prompt, images);
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
        const pollModelName = modelOptionName(task.model);
        const response = task.videoId
            ? await axios.get<AgnesApiVideoResponse>(agnesPollUrl(config.baseUrl, task.videoId, isAgnesVideoFlashModel(pollModelName) ? pollModelName : undefined), { headers: agnesHeaders(config), signal: options?.signal })
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
