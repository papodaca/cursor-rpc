import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartedServer } from "../src/server.ts";
import { catalogueView, type ServerProvider } from "../src/provider.ts";
import { resolveCreateModel } from "../src/openai/models.ts";

const INBOUND_KEY = "sk-inbound-secret";
const servers: StartedServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

function fakeProvider(options: {
  ids?: string[];
  defaultId?: string;
  aliases?: Record<string, string>;
  extra?: Record<string, unknown>;
} = {}): ServerProvider {
  const ids = options.ids ?? ["composer-2", "gpt-5.4"];
  const aliases = new Map(Object.entries(options.aliases ?? { "composer 2": "composer-2" }).map(([k, v]) => [k.toLowerCase(), v]));
  for (const id of ids) {
    aliases.set(id.toLowerCase(), id);
  }
  const view = {
    ids,
    defaultId: options.defaultId ?? ids[0],
    resolve(id: string) {
      return aliases.get(id.toLowerCase());
    },
    ...options.extra,
  };
  return {
    models: async () => view,
    run: async () => {
      throw new Error("run should not be called in models tests");
    },
  };
}

async function start(provider: ServerProvider = fakeProvider()) {
  const started = await startServer({
    env: {
      CURSOR_RPC_OPENAI_API_KEY: INBOUND_KEY,
      CURSOR_RPC_OPENAI_HOST: "127.0.0.1",
      CURSOR_RPC_OPENAI_PORT: "0",
    },
    provider,
  });
  servers.push(started);
  return started;
}

function headers() {
  return { Authorization: `Bearer ${INBOUND_KEY}` };
}

describe("models list and retrieve", () => {
  it("lists canonical ids that retrieve and create-time resolution accept", async () => {
    const { url } = await start();
    const list = await fetch(`${url}/v1/models`, { headers: headers() });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { object: string; data: Array<Record<string, unknown>> };
    expect(body.object).toBe("list");
    const ids = body.data.map((model) => model.id);
    expect(ids).toEqual(["composer-2", "gpt-5.4"]);
    for (const model of body.data) {
      expect(model).toEqual({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "cursor",
      });
    }

    const retrieve = await fetch(`${url}/v1/models/composer-2`, { headers: headers() });
    expect(retrieve.status).toBe(200);
    expect((await retrieve.json()).id).toBe("composer-2");

    const catalogue = await fakeProvider().models();
    expect(resolveCreateModel(catalogue, "composer-2")).toBe("composer-2");
    expect(resolveCreateModel(catalogue, "gpt-5.4")).toBe("gpt-5.4");
  });

  it("resolves aliases and different casing to the canonical id", async () => {
    const { url } = await start();
    const retrieve = await fetch(`${url}/v1/models/Composer-2`, { headers: headers() });
    expect(retrieve.status).toBe(200);
    expect((await retrieve.json()).id).toBe("composer-2");

    const alias = await fetch(`${url}/v1/models/${encodeURIComponent("Composer 2")}`, { headers: headers() });
    expect(alias.status).toBe(200);
    expect((await alias.json()).id).toBe("composer-2");

    const catalogue = await fakeProvider().models();
    expect(resolveCreateModel(catalogue, "COMPOSER-2")).toBe("composer-2");
    expect(resolveCreateModel(catalogue, "Composer 2")).toBe("composer-2");
  });

  it("uses defaultModel then the first id when create omits model", async () => {
    const withDefault = await fakeProvider({ ids: ["a", "b"], defaultId: "b" }).models();
    expect(resolveCreateModel(withDefault, undefined)).toBe("b");
    expect(resolveCreateModel(withDefault, "")).toBe("b");

    const firstOnly = await fakeProvider({ ids: ["a", "b"], defaultId: undefined }).models();
    expect(resolveCreateModel(firstOnly, undefined)).toBe("a");
  });

  it("returns 404 model_not_found with param model for an unknown id", async () => {
    const { url } = await start();
    const retrieve = await fetch(`${url}/v1/models/nope`, { headers: headers() });
    expect(retrieve.status).toBe(404);
    const body = (await retrieve.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });

    const create = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(create.status).toBe(404);
    expect((await create.json()).error.code).toBe("model_not_found");
  });

  it("lists an empty catalogue and 404s create when nothing resolves", async () => {
    const { url } = await start(fakeProvider({ ids: [], defaultId: undefined, aliases: {} }));
    const list = await fetch(`${url}/v1/models`, { headers: headers() });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ object: "list", data: [] });

    const create = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(create.status).toBe(404);
    expect((await create.json()).error.code).toBe("model_not_found");
  });

  it("omits credential-shaped fields from HTTP JSON", async () => {
    const { url } = await start(
      fakeProvider({
        extra: {
          apiKey: "key_should_not_leak",
          accessToken: "tok_secret",
          authorization: "Bearer leaked",
        },
      }),
    );
    const list = await fetch(`${url}/v1/models`, { headers: headers() });
    const listText = await list.text();
    expect(listText).not.toContain("key_should_not_leak");
    expect(listText).not.toContain("tok_secret");
    expect(listText).not.toContain("Bearer leaked");

    const retrieve = await fetch(`${url}/v1/models/composer-2`, { headers: headers() });
    const retrieveText = await retrieve.text();
    expect(retrieveText).not.toContain("key_should_not_leak");
    expect(JSON.parse(retrieveText)).toEqual({
      id: "composer-2",
      object: "model",
      created: 0,
      owned_by: "cursor",
    });
  });

  it("maps a library-shaped catalogue without copying extra fields", () => {
    const view = catalogueView({
      models: [
        { modelId: "composer-2", apiKey: "key_secret", accessToken: "tok" },
        { modelId: "gpt-5.4" },
      ],
      defaultModel: { modelId: "composer-2", apiKey: "key_secret" },
      aliasMap: new Map([
        ["composer-2", "composer-2"],
        ["composer 2", "composer-2"],
        ["gpt-5.4", "gpt-5.4"],
      ]),
      parameterizedModels: [{ apiKey: "key_secret" }],
    });
    expect(view.ids).toEqual(["composer-2", "gpt-5.4"]);
    expect(view.defaultId).toBe("composer-2");
    expect(view.resolve("Composer 2")).toBe("composer-2");
    expect(JSON.stringify(view)).not.toContain("key_secret");
    expect(JSON.stringify(view)).not.toContain("tok");
  });
});
