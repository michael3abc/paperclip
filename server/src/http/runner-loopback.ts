import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";

/** Private PRP listener; the normal runner authentication still applies. */
export function attachRunnerLoopback(
  server: Server,
  register: (server: Server, options: { apiUrl: string }) => void,
  port: number,
): Server {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid Runner loopback port");
  }
  const internal = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new Set<Socket>();
  internal.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  register(internal, { apiUrl: `http://127.0.0.1:${port}` });
  internal.on("upgrade", (request: IncomingMessage & { paperclipWebSocketHandled?: boolean }, socket) => {
    if (!request.paperclipWebSocketHandled) socket.destroy();
  });
  // Recovery depends on this stable endpoint. A bind error must fail startup.
  internal.on("error", error => { throw error; });
  internal.listen(port, "127.0.0.1");
  server.once("close", () => {
    for (const socket of sockets) socket.destroy();
    internal.close();
  });
  return internal;
}
