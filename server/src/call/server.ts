import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { CallSession } from "./callSession.js";

/** Phone-call mode WebSocket at ws://<host>/ws/call. */
export function attachCallServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/call" });
  wss.on("connection", (ws) => new CallSession(ws));
}
