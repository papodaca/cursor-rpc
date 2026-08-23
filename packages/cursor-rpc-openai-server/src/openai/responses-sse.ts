import type { ServerResponse } from "node:http";

export type ResponsesSseEvent = {
  type: string;
  sequence_number: number;
} & Record<string, unknown>;

export type ResponsesSseWriter = {
  emit: (res: ServerResponse, event: { type: string } & Record<string, unknown>) => void;
};

export function writeResponsesSseHeaders(res: ServerResponse, requestId: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("transfer-encoding", "chunked");
  res.setHeader("x-request-id", requestId);
  res.flushHeaders();
  res.socket?.setNoDelay(true);
}

export function writeResponsesSseEvent(res: ServerResponse, event: ResponsesSseEvent): void {
  if (res.writableEnded) {
    return;
  }
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createResponsesSseWriter(): ResponsesSseWriter {
  let sequenceNumber = 0;
  return {
    emit(res, event) {
      writeResponsesSseEvent(res, { ...event, sequence_number: sequenceNumber });
      sequenceNumber += 1;
    },
  };
}

export function writeResponsesReplay(
  res: ServerResponse,
  requestId: string,
  events: Array<{ type: string } & Record<string, unknown>>,
  startingAfter?: number,
): void {
  writeResponsesSseHeaders(res, requestId);
  let sequenceNumber = 0;
  for (const event of events) {
    const numbered = { ...event, sequence_number: sequenceNumber };
    sequenceNumber += 1;
    if (startingAfter !== undefined && numbered.sequence_number <= startingAfter) {
      continue;
    }
    writeResponsesSseEvent(res, numbered);
  }
  if (!res.writableEnded) {
    res.end();
  }
}
