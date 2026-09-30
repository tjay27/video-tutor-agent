// In-memory log of recent calls, for debugging what happened in a test call.
// View at GET /api/calls and /api/calls/:id (or /api/calls/latest).

export interface CallLogEvent {
  /** Milliseconds since the call started. */
  t: number;
  type: string;
  [key: string]: unknown;
}

export interface CallLog {
  id: string;
  videoId?: string;
  startedAt: string;
  endedAt?: string;
  events: CallLogEvent[];
}

const MAX_CALLS = 20;
const calls: CallLog[] = [];

export function createCallLog(): { log: CallLog; record: (type: string, data?: Record<string, unknown>) => void } {
  const started = Date.now();
  const log: CallLog = {
    id: new Date(started).toISOString().replace(/[:.]/g, "-"),
    startedAt: new Date(started).toISOString(),
    events: [],
  };
  calls.push(log);
  if (calls.length > MAX_CALLS) calls.shift();
  const record = (type: string, data: Record<string, unknown> = {}) => {
    log.events.push({ t: Date.now() - started, type, ...data });
  };
  return { log, record };
}

export function listCalls() {
  return calls
    .map(({ id, videoId, startedAt, endedAt, events }) => ({
      id,
      videoId,
      startedAt,
      endedAt,
      questions: events.filter((e) => e.type === "turn").length,
    }))
    .reverse();
}

export function getCall(id: string): CallLog | null {
  if (id === "latest") return calls.at(-1) ?? null;
  return calls.find((c) => c.id === id) ?? null;
}
