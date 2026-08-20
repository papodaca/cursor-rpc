import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "cursor-rpc";
import { ClientEpoch } from "../src/auth.ts";
import { CURSOR_API, PROVIDER_ID } from "../src/constants.ts";
import { fetchCursorModels, toPiModels } from "../src/models.ts";
import { cursorProviderInput } from "../src/provider.ts";

const originalKey = process.env.CURSOR_API_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.CURSOR_API_KEY;
  } else {
    process.env.CURSOR_API_KEY = originalKey;
  }
});

describe("model catalogue", () => {
  it("two usable models become two Pi models with the custom api id", () => {
    const models = toPiModels({
      models: [
        { modelId: "composer-2.5", displayName: "Composer" },
        { modelId: "gpt-5", displayName: "GPT-5" },
      ],
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "composer-2.5",
      provider: PROVIDER_ID,
      api: CURSOR_API,
      input: ["text"],
    });
    expect(models[1]?.id).toBe("gpt-5");
  });

  it("empty usable list returns []", () => {
    expect(toPiModels({ models: [] })).toEqual([]);
  });

  it("omits Auto and default catalogue ids", () => {
    expect(
      toPiModels({
        models: [
          { modelId: "auto", displayName: "Auto" },
          { modelId: "default", displayName: "Default" },
          { modelId: "gpt-5", displayName: "GPT-5" },
        ],
      }).map((model) => model.id),
    ).toEqual(["gpt-5"]);
  });

  it("no credentials / auth errors return [] without throwing", async () => {
    await expect(
      fetchCursorModels(async () => {
        throw new AuthenticationError("authentication required");
      }),
    ).resolves.toEqual([]);
  });

  it("aborted signal returns [] without hanging", async () => {
    const signal = AbortSignal.abort();
    await expect(
      fetchCursorModels(async () => {
        throw new Error("network");
      }, signal),
    ).resolves.toEqual([]);
  });

  it("fetchModels AuthenticationError drops the pinned Client", async () => {
    process.env.CURSOR_API_KEY = "key_live_test";
    const close = vi.fn();
    const created: unknown[] = [];
    const epoch = new ClientEpoch(() => {
      const client = {
        models: async () => {
          throw new AuthenticationError("expired");
        },
        run: async () => {
          throw new Error("unused");
        },
        close,
      };
      created.push(client);
      return client;
    });
    const input = cursorProviderInput({ epoch });
    await expect(input.fetchModels?.({})).resolves.toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(input.fetchModels?.({})).resolves.toEqual([]);
    expect(created).toHaveLength(2);
  });
});
