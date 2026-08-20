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
      models: [create(ModelDetailsSchema, { modelId: "composer-2.5", aliases: ["Composer"] })],
    });
    const timed = mergeModelCatalogue(usable, undefined, "timed_out");
    expect(timed.parameterizedModelsFetchStatus).toBe("timed_out");
    expect(timed.models).toHaveLength(1);
    expect(timed.aliasMap.get("composer")).toBe("composer-2.5");

    expect(() => mergeModelCatalogue(new Error("usable failed"), undefined, "timed_out")).toThrow(/usable failed/);

    const raced = await withTimeout(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("late"), 30);
      }),
      5,
    );
    expect(raced).toBe("timed_out");
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
