import type { ServerResponse } from "node:http";

export type CompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: unknown[];
  usage?: Usage;
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export function writeSseHeaders(res: ServerResponse, requestId: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("transfer-encoding", "chunked");
  res.setHeader("x-request-id", requestId);
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  res.write(": ok\n\n");
}

export function writeSseData(res: ServerResponse, payload: unknown): void {
  if (res.writableEnded) {
    return;
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeSseDone(res: ServerResponse): void {
  if (res.writableEnded) {
    return;
  }
  res.write("data: [DONE]\n\n");
}

export function completionChunk(
  id: string,
  created: number,
  model: string,
  choices: unknown[],
  usage?: Usage,
): CompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices,
    ...(usage === undefined ? {} : { usage }),
  };
}
