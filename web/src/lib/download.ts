import { saveAs } from "file-saver";

import { fetchRemoteMediaBlob } from "@/services/image-storage";

/**
 * Download a media URL as a file. Cross-origin https:// URLs ignore the <a download>
 * attribute (the browser opens a preview tab instead), so remote URLs are fetched
 * through the blob fallback chain (direct → /api/image-proxy → /api/proxy) and saved
 * as a same-origin blob. blob:/data: URLs download directly; if every fetch fails we
 * fall back to opening the URL in a new tab (the previous behavior).
 */
export async function downloadMedia(url: string, fileName: string): Promise<void> {
    if (!/^https?:/i.test(url)) {
        saveAs(url, fileName);
        return;
    }
    const blob = await fetchRemoteMediaBlob(url, (mimeType) => /^(image|video|audio)\//.test(mimeType));
    if (blob) {
        saveAs(blob, fileName);
        return;
    }
    window.open(url, "_blank", "noopener");
}
