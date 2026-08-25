import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    let blob: Blob;
    if (typeof input === "string" && isAgnesMediaUrl(input)) {
        // Agnes image URLs may reject CORS fetches; try dev proxies, then keep the remote URL as a last resort.
        const fetched = await fetchRemoteMediaBlob(input, (mimeType) => mimeType.startsWith("image/"));
        if (!fetched) {
            const meta = await readImageMeta(input);
            return { url: input, storageKey: "", width: meta.width, height: meta.height, bytes: 0, mimeType: meta.mimeType || "image/png" };
        }
        blob = fetched;
    } else {
        blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    }
    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

function isAgnesMediaUrl(url: string) {
    return /^https?:\/\//i.test(url) && url.toLowerCase().includes("agnes");
}

/**
 * Fetch a remote media URL as a Blob through the fallback chain:
 * direct CORS fetch → /api/image-proxy<path> (dev, host-locked to platform-outputs) → /api/proxy?url= (dev passthrough).
 * `isAcceptable` gates the mime type so callers only store real media (a bad proxy hit returns the SPA HTML shell).
 */
export async function fetchRemoteMediaBlob(url: string, isAcceptable: (mimeType: string) => boolean): Promise<Blob | null> {
    const attempts: Array<() => Promise<Blob | null>> = [
        () => fetchBlobWithTimeout(url, { mode: "cors" }, isAcceptable),
        () => {
            const urlObj = new URL(url);
            return fetchBlobWithTimeout(`/api/image-proxy${urlObj.pathname}${urlObj.search}`, undefined, isAcceptable);
        },
        () => fetchBlobWithTimeout(`/api/proxy?url=${encodeURIComponent(url)}`, undefined, isAcceptable),
    ];
    for (const attempt of attempts) {
        try {
            const blob = await attempt();
            if (blob) return blob;
        } catch {
            // Try the next fallback.
        }
    }
    return null;
}

async function fetchBlobWithTimeout(input: string, init: RequestInit | undefined, isAcceptable: (mimeType: string) => boolean): Promise<Blob | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(input, { ...init, signal: controller.signal });
        if (!response.ok) return null;
        const blob = await response.blob();
        return isAcceptable(blob.type) ? blob : null;
    } finally {
        clearTimeout(timer);
    }
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
