import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachRealtimeRelay } from "./realtime-relay.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
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

try {
  attachRealtimeRelay(server, { model });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

server.on("error", (error) => {
  if (error.code !== "EADDRINUSE") {
    throw error;
  }

  console.warn(`Port ${port} is busy, so a free port will be used instead.`);
  server.listen(0);
});

server.listen(port, () => {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;

  console.log(`Realtime WebSocket relay running at http://localhost:${activePort}`);
  console.log(`Browser WebSocket endpoint: ws://localhost:${activePort}/realtime`);
});
