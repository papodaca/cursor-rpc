import { afterEach, describe, expect, it } from "vitest";
import { streamCursor } from "../src/stream.ts";
import { asTestStream, fakeEpoch, TEST_MODEL, waitForStream } from "./helpers.ts";

const originalKey = process.env.CURSOR_API_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.CURSOR_API_KEY;
  } else {
    process.env.CURSOR_API_KEY = originalKey;
  }
});

describe("stream abort", () => {
  it("options.signal abort yields aborted and tears down the fake Run", async () => {
    process.env.CURSOR_API_KEY = "key_live_test";
    const controller = new AbortController();
    const { epoch, runs } = fakeEpoch({
      events: () => {
        controller.abort();
        return [
          { type: "text_delta", text: "partial" },
          { type: "turn_ended", usage: {} },
        ];
      },
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }, { signal: controller.signal }),
    );
    await waitForStream(stream);
    const error = stream.events.find((event) => event.type === "error");
    expect(error?.type === "error" ? error.reason : undefined).toBe("aborted");
    expect(runs[0]?.abortCount).toBeGreaterThan(0);
  });
});
