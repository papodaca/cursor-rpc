## Compact a response

**post** `/responses/compact`

Compact a conversation. Returns a compacted response object.

### Body Parameters

- `model: string or null`

  Model ID used to generate the response, like `gpt-5` or `o3`. OpenAI
  offers a wide range of models with different capabilities, performance
  characteristics, and price points.

- `input: optional string or array of input items or null`

  Text, messages, or prior output items to compact.

- `instructions: optional string or null`

  A system (or developer) message inserted into the model’s context. When
  used along with `previous_response_id`, the instructions from a previous
  response will not be carried over to the next response. This makes it
  simple to swap out system (or developer) messages in new responses.

- `previous_response_id: optional string or null`

  The unique ID of the previous response to the model. Use this to create
  multi-turn conversations. Cannot be used in conjunction with
  `conversation`.

- `prompt_cache_key: optional string or null`

  A key to use when reading from or writing to the prompt cache.

- `prompt_cache_options: optional object { mode, ttl } or null`

  Options for prompt caching.

- `prompt_cache_retention: optional "in_memory" or "24h" or null`

  How long to retain a prompt cache entry created by this request.
  Deprecated.

- `service_tier: optional "auto" or "default" or "fast" or "flex" or "priority" or null`

  Specifies the processing type used for serving the request.

### Returns

- `CompactedResponse object { id, created_at, object, 2 more }`

  - `id: string`

    The unique identifier for the compacted response.

  - `created_at: number`

    Unix timestamp (in seconds) when the compacted conversation was created.

  - `object: "response.compaction"`

    The object type. Always `response.compaction`.

  - `output: array`

    The compacted list of output items. May include a `compaction` item
    with `encrypted_content`.

### Example

```http
curl -X POST https://api.openai.com/v1/responses/compact \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -d '{
      "model": "gpt-5.1-codex-max",
      "input": [
        {
          "role": "user",
          "content": "Create a simple landing page for a dog petting café."
        },
        {
          "id": "msg_001",
          "type": "message",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "annotations": [],
              "logprobs": [],
              "text": "Below is a single file, ready-to-use landing page for a dog petting café:..."
            }
          ],
          "role": "assistant"
        }
      ]
    }'
```

#### Response

```json
{
  "id": "resp_001",
  "object": "response.compaction",
  "created_at": 1764967971,
  "output": [
    {
      "id": "msg_000",
      "type": "message",
      "status": "completed",
      "content": [
        {
          "type": "input_text",
          "text": "Create a simple landing page for a dog petting cafe."
        }
      ],
      "role": "user"
    },
    {
      "id": "cmp_001",
      "type": "compaction",
      "encrypted_content": "gAAAAABpM0Yj-...="
    }
  ],
  "usage": {
    "input_tokens": 139,
    "input_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 0
    },
    "output_tokens": 438,
    "output_tokens_details": {
      "reasoning_tokens": 64
    },
    "total_tokens": 577
  }
}
```
