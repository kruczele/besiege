import { createServer } from "node:http";
import { join } from "node:path";
import { proxyToDaemon } from "./proxy.js";
import { proxyTerminalStream } from "./ws-proxy.js";
import { serveStatic } from "./static.js";
import { isServicePath, proxyToService, upgradeToService } from "./service-proxy.js";

const port = Number(process.env.BESIEGE_WEB_PORT ?? 4571);
const host = "127.0.0.1";
// out/web-server/index.js -> out/web (sibling build output from vite.web.config.ts).
const clientRoot = join(__dirname, "../web");

const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) {
    proxyToDaemon(req, res);
    return;
  }
  if (isServicePath(req.url)) {
    void proxyToService(req, res);
    return;
  }
  serveStatic(clientRoot, req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (isServicePath(req.url)) {
    void upgradeToService(req, socket, head);
    return;
  }
  const match = req.url?.match(/^\/api\/terminals\/(\d+)\/stream$/);
  if (!match) {
    socket.destroy();
    return;
  }
  proxyTerminalStream(Number(match[1]), req, socket, head);
});

server.listen(port, host, () => {
  console.log(`besiege web UI listening on http://${host}:${port}`);
});
