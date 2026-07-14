# Model provider test status

This document tracks end-to-end manual coverage for every built-in model provider type in
`ModelProviderType` / `KNOWN_PROVIDER_TYPES` (`packages/protocol/src/control.ts`).

This is a living status tracker: if you verify a provider end-to-end (setup, credential
validation, model listing, profile selection, invocation), please update the table below.

## Status definitions

| Status | Meaning |
|---|---|
| Fully tested | Provider has been exercised through provider setup, credential validation, model listing, profile selection, and model invocation paths. |
| Not fully tested | Provider exists in the catalog but still needs complete verification across setup, listing, profile selection, and invocation. |

## Fully tested

| Provider type | Label | Notes |
|---|---|---|
| `openrouter` | OpenRouter | Fully tested. |
| `deepseek` | DeepSeek | Fully tested. |
| `vercel-gateway` | Vercel AI Gateway | Fully tested. |

## Not fully tested

| Provider type | Label | Notes |
|---|---|---|
| `anthropic` | Anthropic | Needs full provider verification. |
| `openai` | OpenAI | Needs full provider verification. |
| `google` | Google Gemini | Needs full provider verification. |
| `mistral` | Mistral | Needs full provider verification. |
| `amazon-bedrock` | Amazon Bedrock | Needs full provider verification. |
| `azure` | Azure OpenAI | Needs full provider verification. |
| `openai-compatible` | OpenAI-compatible | Needs full provider verification. |
| `cloudflare-gateway` | Cloudflare | Needs full provider verification. |
| `groq` | Groq | Needs full provider verification. |
| `xai` | xAI Grok | Needs full provider verification. |
| `together` | Together AI | Needs full provider verification. |
| `fireworks` | Fireworks | Needs full provider verification. |
| `cerebras` | Cerebras | Needs full provider verification. |
| `perplexity` | Perplexity | Needs full provider verification. |
| `moonshot` | Moonshot | Needs full provider verification. |
| `zai` | Z.AI | Needs full provider verification. |
| `minimax` | MiniMax | Needs full provider verification. |
| `nvidia` | NVIDIA NIM | Needs full provider verification. |
| `novita` | Novita | Needs full provider verification. |
| `ollama` | Ollama | Needs full provider verification. |
| `huggingface` | Hugging Face | Needs full provider verification. |
