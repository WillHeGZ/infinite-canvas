import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

// Generic passthrough proxy for /api/proxy?url=<encoded http(s) url> (dev only).
// The built-in proxy option cannot do this: without a rewrite it forwards the literal
// path "/api/proxy?url=..." to the target host, which the object storage answers with NoSuchKey.
function remoteUrlPassthroughProxy(): Plugin {
    return {
        name: "remote-url-passthrough-proxy",
        configureServer(server) {
            server.middlewares.use("/api/proxy", async (req, res) => {
                try {
                    const requestUrl = new URL(req.url || "", "http://localhost");
                    const target = requestUrl.searchParams.get("url");
                    if (!target || !/^https?:\/\//i.test(target)) {
                        res.statusCode = 400;
                        res.end("Missing or invalid url parameter");
                        return;
                    }
                    const upstream = await fetch(target);
                    if (!upstream.ok || !upstream.body) {
                        res.statusCode = upstream.status || 502;
                        res.end(`Upstream responded ${upstream.status}`);
                        return;
                    }
                    res.statusCode = 200;
                    const contentType = upstream.headers.get("content-type");
                    if (contentType) res.setHeader("Content-Type", contentType);
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    const reader = upstream.body.getReader();
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(value);
                    }
                    res.end();
                } catch {
                    res.statusCode = 502;
                    res.end("Proxy fetch failed");
                }
            });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), remoteUrlPassthroughProxy()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
    server: {
        proxy: {
            // Agnes API gateway proxy (dev only; production connects directly).
            "/api/ai": {
                target: "https://apihub.agnes-ai.com",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/ai/, ""),
            },
            "/api/image-proxy": {
                target: "https://platform-outputs.agnes-ai.space",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/image-proxy/, ""),
            },
            // /api/proxy is handled by remoteUrlPassthroughProxy() above (needs ?url= parsing,
            // which the built-in path-based proxy cannot express).
        },
    },
});
