import { fetchRemoteMediaBlob } from "@/services/image-storage";

export type VideoFrameTarget = "first" | "last" | "current";

/** 90% of a second before the end: seeking exactly to `duration` fails/black-frames in some browsers. */
function lastFrameTime(duration: number) {
    return Math.max(0, (Number.isFinite(duration) ? duration : 0) - 0.05);
}

function drawVideoFrame(video: HTMLVideoElement): string {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1;
    canvas.height = video.videoHeight || 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

/** Resolve once the video element reaches loadedmetadata; rejects on media errors. */
function waitForMetadata(video: HTMLVideoElement, timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
        if (video.readyState >= 1) return resolve();
        const cleanup = () => {
            video.removeEventListener("loadedmetadata", onLoad);
            video.removeEventListener("error", onError);
            clearTimeout(timer);
        };
        const onLoad = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error("video-load-failed"));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("video-load-timeout"));
        }, timeoutMs);
        video.addEventListener("loadedmetadata", onLoad, { once: true });
        video.addEventListener("error", onError, { once: true });
    });
}

/** Resolve once the pending seek completes; rejects on media errors or stall. */
function waitForSeek(video: HTMLVideoElement, timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            video.removeEventListener("seeked", onSeeked);
            video.removeEventListener("error", onError);
            clearTimeout(timer);
        };
        const onSeeked = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error("video-seek-failed"));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("video-seek-timeout"));
        }, timeoutMs);
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
    });
}

/** Resolve once the video has decoded at least one frame (readyState >= 2). */
function waitForLoadedData(video: HTMLVideoElement, timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
        if (video.readyState >= 2) return resolve();
        const cleanup = () => {
            video.removeEventListener("loadeddata", onLoad);
            video.removeEventListener("error", onError);
            clearTimeout(timer);
        };
        const onLoad = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error("video-load-failed"));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("video-load-timeout"));
        }, timeoutMs);
        video.addEventListener("loadeddata", onLoad, { once: true });
        video.addEventListener("error", onError, { once: true });
    });
}

async function captureFromSource(src: string, target: Exclude<VideoFrameTarget, "current">): Promise<string> {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = src;
    try {
        await waitForMetadata(video, 10000);
        const seekTo = target === "first" ? 0 : lastFrameTime(video.duration);
        if (seekTo > 0) {
            video.currentTime = seekTo;
            await waitForSeek(video, 10000);
        } else {
            // Seeking to 0 from a fresh element may not fire "seeked"; wait for the first decoded frame.
            await waitForLoadedData(video, 10000);
        }
        return drawVideoFrame(video);
    } finally {
        video.removeAttribute("src");
        video.load();
    }
}

/**
 * Extract a frame from a video as a lossless PNG data URL.
 * - "current" prefers the live canvas <video> element (same-origin blob: URLs never taint);
 * - first/last use an offscreen video element with an explicit seek;
 * - cross-origin remote URLs taint the canvas (SecurityError) → re-fetch through the proxy
 *   fallback chain (fetchRemoteMediaBlob) and retry once from a same-origin blob URL.
 * The canvas is sized to the video's native resolution, so the capture is pixel-perfect.
 */
export async function captureVideoFrame(src: string, target: VideoFrameTarget, videoEl?: HTMLVideoElement): Promise<string> {
    try {
        if (target === "current") {
            const video = videoEl?.videoWidth ? videoEl : undefined;
            if (video) return drawVideoFrame(video);
            return await captureFromSource(src, "first");
        }
        return await captureFromSource(src, target);
    } catch (error) {
        const tainted = error instanceof DOMException && error.name === "SecurityError";
        if (!tainted || !/^https?:/i.test(src)) throw error;
        const blob = await fetchRemoteMediaBlob(src, (mimeType) => mimeType.startsWith("video/"));
        if (!blob) throw error;
        const objectUrl = URL.createObjectURL(blob);
        try {
            return await captureFromSource(objectUrl, target === "current" ? "first" : target);
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }
}

/** Actual playback position of a live video element, for the "当前帧 (xx.xs)" node title. */
export function videoCurrentTimeLabel(videoEl?: HTMLVideoElement | null) {
    const time = videoEl && Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
    return `${time.toFixed(1)}s`;
}
