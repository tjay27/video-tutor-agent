import { Router } from "express";
import { HttpError } from "../errors.js";
import { getCall, listCalls } from "../call/callLog.js";

export const callsRouter = Router();

callsRouter.get("/", (_req, res) => {
  res.json(listCalls());
});

/** Full event log for one call; use "latest" for the most recent call. */
callsRouter.get("/:id", (req, res) => {
  const call = getCall(req.params.id);
  if (!call) throw new HttpError(404, "Call not found");
  res.json(call);
});
