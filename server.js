// @ts-check
import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { attachRealtimeRelay } from "./realtime-relay.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wav": "audio/wav"
};

/**
 * Boot the local HTTP server + WebSocket relay. Serves static files from
 * `public/` and attaches the realtime relay at `/realtime`. Defaults to an
 * OS-chosen free port (port 0) so the relay never collides with another dev
 * server on a well-known port like 3000 — a recurring cause of the dictation
 * window loading the wrong app. Set PORT to pin a specific port; if that's
 * taken, it still falls back to a free one.
 *
 * @param {{ port?: number, model?: string, recordingsDir?: string }} [options]
 * @returns {Promise<{ server: import("node:http").Server, port: number }>}
 */
export function startServer({ port = Number(process.env.PORT || 0), model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2", recordingsDir } = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    // Saved failed-dictation recordings live outside public/ (in the app's
    // user-data dir) so the pop-up can play them back. Serve them read-only,
    // guarding against path traversal by allowing only the bare filename.
    if (recordingsDir && url.pathname.startsWith("/recordings/")) {
      // Malformed percent-encoding (%zz) throws — treat it as not-found
      // instead of an unhandled rejection that kills a bare `node server.js`.
      let name = "";
      try { name = decodeURIComponent(url.pathname.slice("/recordings/".length)); } catch {}
      const target = resolve(recordingsDir, name);
      // Must be a .wav that resolves to a direct child of recordingsDir — this
      // contains any traversal (../, encoded separators, absolute paths).
      const base = resolve(recordingsDir);
      if (extname(name) !== ".wav" || !target.startsWith(base + sep) || target.slice(base.length + 1).includes(sep)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      try {
        const body = await readFile(target);
        response.writeHead(200, { "content-type": mimeTypes[".wav"] });
        response.end(body);
      } catch {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
      }
      return;
    }

    const pathname = url.pathname === "/" ? "/public/index.html" : `/public${url.pathname}`;
    const filePath = join(__dirname, pathname);

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": mimeTypes[extname(filePath)] || "application/octet-stream"
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  attachRealtimeRelay(server, { model });

  return new Promise((resolve, reject) => {
    server.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      console.warn(`Port ${port} is busy, so a free port will be used instead.`);
      server.listen(0, "127.0.0.1");
    });

    // Loopback only: the relay serves saved voice recordings and spends the
    // API keys, so it must never be reachable from the LAN. (whisper-server
    // already binds 127.0.0.1; this keeps the relay consistent with it.)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const activePort = typeof address === "object" && address ? address.port : port;

      console.log(`Realtime WebSocket relay running at http://localhost:${activePort}`);
      console.log(`Browser WebSocket endpoint: ws://localhost:${activePort}/realtime`);
      resolve({ server, port: activePort });
    });
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
