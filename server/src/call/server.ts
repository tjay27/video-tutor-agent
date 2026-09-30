import type { Server, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "../config.js";
import { CallSession } from "./callSession.js";

// Sessions started per visitor IP today (in memory; resets on restart and at midnight UTC).
const perIp = new Map<string, number>();
let perIpDay = new Date().toISOString().slice(0, 10);

function clientIp(req: IncomingMessage): string {
  // Behind a host's proxy (Render, Railway), the visitor's IP is the first X-Forwarded-For entry.
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function refuse(ws: WebSocket, message: string) {
  ws.send(JSON.stringify({ type: "limit", message }));
  ws.close(1008, "limit");
}

/** Voice session WebSocket at ws://<host>/ws/call. */
export function attachCallServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/call" });
  let active = 0;

  wss.on("connection", (ws, req) => {
    const { maxConcurrentSessions, maxSessionsPerIpPerDay } = config.limits;

    if (maxConcurrentSessions && active >= maxConcurrentSessions) {
      return refuse(ws, "The tutor is busy with other visitors right now. Please try again in a few minutes.");
    }

    const today = new Date().toISOString().slice(0, 10);
    if (today !== perIpDay) {
      perIp.clear();
      perIpDay = today;
    }
    const ip = clientIp(req);
    const used = perIp.get(ip) ?? 0;
    if (maxSessionsPerIpPerDay && used >= maxSessionsPerIpPerDay) {
      return refuse(ws, "You've reached today's limit for this demo. Please come back tomorrow, or run it locally with your own Sarvam key.");
    }
    perIp.set(ip, used + 1);

    active++;
    ws.on("close", () => active--);
    new CallSession(ws);
  });
}
