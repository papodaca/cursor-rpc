import { describe, expect, it } from "vitest";
import { AuthenticationError } from "cursor-rpc";
import { CURSOR_API, PROVIDER_ID } from "../src/constants.ts";
import { fetchCursorModels, toPiModels } from "../src/models.ts";

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
});
