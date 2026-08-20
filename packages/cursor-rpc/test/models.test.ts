import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  AvailableModelSchema,
  GetDefaultModelForCliResponseSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/generated/aiserver/v1/models_pb.ts";
import { mergeModelCatalogue, withTimeout } from "../src/session/models.ts";

describe("model catalogue merge", () => {
  it("treats AvailableModels timeout as a soft degrade and usable failure as fatal", async () => {
    const usable = create(GetUsableModelsResponseSchema, {
      models: [
        create(ModelDetailsSchema, {
          modelId: "composer-2.5",
          aliases: ["Composer"],
          displayName: "Composer 2.5",
          displayNameShort: "C2.5",
        }),
      ],
    });
    const timed = mergeModelCatalogue(usable, undefined, "timed_out");
    expect(timed.parameterizedModelsFetchStatus).toBe("timed_out");
    expect(timed.models).toHaveLength(1);
    expect(timed.aliasMap.get("composer")).toBe("composer-2.5");
    expect(timed.aliasMap.get("composer 2.5")).toBe("composer-2.5");
    expect(timed.aliasMap.get("c2.5")).toBe("composer-2.5");
    expect(() => mergeModelCatalogue(create(GetUsableModelsResponseSchema, { models: [] }), undefined, "timed_out")).toThrow(
      /usable models list is empty/,
    );

    expect(() => mergeModelCatalogue(new Error("usable failed"), undefined, "timed_out")).toThrow(/usable failed/);

    let aborted = false;
    const raced = await withTimeout(
      (signal) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve("late"), 30);
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(timer);
              reject(new DOMException("This operation was aborted", "AbortError"));
            },
            { once: true },
          );
        }),
      5,
    );
    expect(raced).toBe("timed_out");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });

  it("does not treat a local gpt-5 preference as usable unless the catalogue contains it", () => {
    const usable = create(GetUsableModelsResponseSchema, {
      models: [create(ModelDetailsSchema, { modelId: "composer-2.5" })],
    });
    const merged = mergeModelCatalogue(
      usable,
      create(GetDefaultModelForCliResponseSchema, {
        model: create(ModelDetailsSchema, { modelId: "gpt-5" }),
      }),
      [
        create(AvailableModelSchema, {
          name: "claude-4.5-haiku",
          parameterDefinitions: [{ id: "thinking", name: "thinking" }],
        }),
      ],
    );
    expect(merged.models.some((model) => model.modelId === "gpt-5")).toBe(false);
    expect(merged.aliasMap.has("gpt-5")).toBe(false);
    expect(merged.parameterizedModels).toBeUndefined();
  });
});
