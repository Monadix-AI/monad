# Monad Model Provider Sample (JSON-first)

Use this as a reference when onboarding a custom endpoint without writing a TS atom pack.

This works best when your endpoint is OpenAI-compatible.

Official providers are implemented in TypeScript inside monad core.
User custom providers should prefer JSON config when the endpoint is OpenAI-compatible.

## 1) config.json

Add a provider and a profile in ~/.monad/config.json:

```json
{
  "model": {
    "default": "acme-chat",
    "providers": [
      {
        "id": "acme",
        "label": "Acme Gateway",
        "type": "openai-compatible",
        "baseUrl": "https://api.acme.ai/v1"
      }
    ],
    "profiles": [
      {
        "alias": "acme-chat",
        "provider": "acme",
        "modelId": "acme-chat-1",
        "params": {
          "temperature": 0.7,
          "reasoningEffort": "medium"
        },
        "fallbacks": []
      }
    ]
  }
}
```

## 2) auth.json

Add one credential under the same provider id in ~/.monad/auth.json:

```json
{
  "activeProvider": "acme",
  "credentialPool": {
    "acme": [
      {
        "id": "cred_acme_main",
        "label": "Acme API Key",
        "authType": "api_key",
        "priority": 100,
        "source": "manual",
        "accessToken": "YOUR_API_KEY",
        "lastStatus": "unknown",
        "lastStatusAt": null,
        "lastErrorCode": null,
        "lastErrorReason": null,
        "lastErrorMessage": null,
        "lastErrorResetAt": null,
        "requestCount": 0
      }
    ]
  }
}
```

## Notes

- provider id must match in both files (example: acme).
- For OpenAI-compatible providers, type should be openai-compatible.
- If your provider is not OpenAI-compatible, then create a TS atom pack and register it via defaultProviderRegistry.
