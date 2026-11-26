---
title: "Langfuse Topics: connection, embedding, and timeout traps"
date: 2026-11-26
category: integration-issues
module: apps/traces
problem_type: integration_issue
component: tooling
symptoms:
  - "The Langfuse UI refuses to save the embedder connection with 'Could not verify the API key'"
  - "The proxy answers HTTP 400 MissingSessionID, or the connection save fails with 'gpt-4.1 missing'"
  - "The embedding test fails with 'Unprocessable Entity' (422)"
  - "A slot save test fails with 'No output generated.' or 'No object generated: could not parse the response.'"
  - "A model passes its save test, then the first map fit times out and forms no topics"
root_cause: incomplete_setup
resolution_type: environment_setup
severity: medium
tags: [langfuse, topics, tei, embeddings, llm-connections, cliproxy, opencode-go, self-hosted]
---

# Langfuse Topics: connection, embedding, and timeout traps

## Problem

Following the Langfuse UI alone does not enable Topics on the self-hosted stack. Several steps fail in ways the UI explains poorly. Ingest is not affected. The procedure is in the [runbook](../../runbooks/trace-collection.md#topics). Citations pin Langfuse v4.86.0.

## Solution

- **Create an embeddings-only server through the API.** The connection form runs a chat-completion test before it saves, and an embeddings server cannot pass it (`web/src/features/public-api/components/CreateLLMApiKeyForm.tsx:845-877`). `PUT /api/public/llm-connections` skips the test. It needs a key with the ADMIN role, and `withDefaultModels` must be sent as `false` because it defaults to `true`.
- **A positive host allow-list also restricts.** `LANGFUSE_LLM_CONNECTION_ALLOWED_HOSTS` lets the private host `embedder` through, and it rejects every unlisted host, other providers included (`packages/shared/src/server/outbound-url/validation.ts:178-191`).
- **A provider's default models can route trace content to a third party.** With no custom model, the save test uses the adapter's first default (`web/src/features/llm-api-key/server/llmConnectionService.ts:400-402`). List Go ids as custom models, turn default models off, and do not use the anthropic adapter: its defaults reach Anthropic.
- **Set embedding dimensions before anything is embedded.** The setup wizard has no dimensions field. It sends the stored value, 1024 by default (`packages/shared/src/server/topics/model-config.ts:431`), and TEI rejects dimensions above its model's 384. Model and dimensions lock once summaries exist (`web/src/features/topics/ConfigureTopicsDialog.tsx:36-40`). Set 384 in Settings first, then create the first map with Set up topics: Settings creates no map.
- **A model can pass its save test and still time out.** The summary and clustering save tests are structured-output calls capped at 512 tokens, with a timeout of up to 95 s (`model-config.ts:704-717`, `packages/shared/src/server/llm/llmText.ts:69-76`). The embedding slot is tested with two texts at the configured dimensions (`model-config.ts:720-736`). Map processing uses a fixed 60 s timeout (`packages/shared/src/server/topics/text.ts:29`). A reasoning model fails one limit or the other. Use a non-reasoning Go model.
- **Oversized transcripts are skipped.** Above `LANGFUSE_TOPICS_MAX_INPUT_CHARACTERS` (500000) a trace gets no model call (`worker/src/env.ts:180-184`).

The session-header and retention lessons are separate: [the session header and billing source](opencode-go-through-cliproxy-session-header-billing-source-2026-11-05.md) and [the Langfuse upgrade and retention doc](../best-practices/langfuse-upgrade-review-new-tables-outside-retention-2026-11-25.md).

## Prevention

Re-verify these citations when Langfuse is bumped. Record the date of each live check in the runbook's "Verified on the host" list.
