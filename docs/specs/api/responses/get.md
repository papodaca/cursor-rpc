## Get a model response

**get** `/responses/{response_id}`

Retrieves a model response with the given ID.

### Path Parameters

- `response_id: string`

### Query Parameters

- `include: optional array of ResponseIncludable`

  Additional fields to include in the response. See the `include` parameter
  for Response creation above for more information.

  One of the following:

  - `"file_search_call.results"`
  - `"web_search_call.results"`
  - `"web_search_call.action.sources"`
  - `"message.input_image.image_url"`
  - `"computer_call_output.output.image_url"`
  - `"code_interpreter_call.outputs"`
  - `"reasoning.encrypted_content"`
  - `"message.output_text.logprobs"`

- `include_obfuscation: optional boolean`

  When true, stream obfuscation will be enabled. Stream obfuscation adds
  random characters to an `obfuscation` field on streaming delta events to
  normalize payload sizes as a mitigation to certain side-channel attacks.
  These obfuscation fields are included by default, but add a small amount
  of overhead to the data stream. You can set `include_obfuscation` to false
  to optimize for bandwidth if you trust the network links between your
  application and the OpenAI API.

- `starting_after: optional number`

  The sequence number of the event after which to start streaming.

- `stream: optional false`

  If set to true, the model response data will be streamed to the client as
  it is generated using server-sent events.

### Returns

- `Response object { id, created_at, error, 32 more }`

  Unique identifier for this Response.

### Example

```http
curl https://api.openai.com/v1/responses/resp_123 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $OPENAI_API_KEY"
```

#### Response

```json
{
  "id": "resp_67cb71b351908190a308f3859487620d06981a8637e6bc44",
  "object": "response",
  "created_at": 1741386163,
  "status": "completed",
  "completed_at": 1741386164,
  "error": null,
  "incomplete_details": null,
  "instructions": null,
  "max_output_tokens": null,
  "model": "gpt-4o-2024-08-06",
  "output": [
    {
      "type": "message",
      "id": "msg_67cb71b3c2b0819084d481baaaf148f206981a8637e6bc44",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Silent circuits hum,  \nThoughts emerge in data streams—  \nDigital dawn breaks.",
          "annotations": []
        }
      ]
    }
  ],
  "parallel_tool_calls": true,
  "previous_response_id": null,
  "reasoning": {
    "effort": null,
    "summary": null
  },
  "store": true,
  "temperature": 1.0,
  "text": {
    "format": {
      "type": "text"
    }
  },
  "tool_choice": "auto",
  "tools": [],
  "top_p": 1.0,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 32,
    "input_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 0
    },
    "output_tokens": 18,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 50
  },
  "user": null,
  "metadata": {}
}
```
