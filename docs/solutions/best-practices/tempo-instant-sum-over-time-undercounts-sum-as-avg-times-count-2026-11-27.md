---
title: "An instant sum_over_time on a Tempo span attribute can undercount: sum as average times count"
date: 2026-11-27
module: apps/traces
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "A reader totals a span attribute, such as a token count, through Tempo metrics queries"
  - "The attribute is a counter that is never negative"
tags: [tempo, traceql, metrics, sum-over-time, token-counts, reader]
---

# An instant sum_over_time on a Tempo span attribute can undercount: sum as average times count

## Context

Readers total span attributes, mostly `gen_ai.usage.*` token counts, through Tempo metrics queries (Tempo 3.1.1, `apps/traces/docker-compose.yaml:292`). The query limits and the other reader rules are in the runbook's [Consumer contract](../../runbooks/trace-collection.md#consumer-contract).

## Guidance

An instant `sum_over_time(span.<attr>)` can return far less than the true total. The cause is unknown; some series are unaffected. Use one of these recipes instead.

For a counter that is never negative:

1. Multiply `avg_over_time(span.<attr>)` by `count_over_time()`. Filter both queries on `span.<attr> >= 0` so they cover the same spans.
2. Or run `sum_over_time(span.<attr>)` as a range query with the same filter and window, and add up the bucket values.

The `>= 0` filter drops negative values without a warning, so do not use these recipes for signed values. Do not add up range averages or rates. They do not recover the total.

## Why This Matters

On one trace the instant sum returned 107,843, while the summed range buckets gave 4,757,785. `count_over_time` and `avg_over_time` instants over the same spans matched the range totals. A silently low total looks like real data.

## When to Apply

Whenever you total a Tempo span attribute that is a non-negative counter.

## Examples

For cache-read tokens (`gen_ai.usage.cache_read.input_tokens`, listed at `apps/traces/config/otelcol.yaml:154`), run both queries over the same window:

```text
{ span.gen_ai.usage.cache_read.input_tokens >= 0 } | avg_over_time(span.gen_ai.usage.cache_read.input_tokens)
{ span.gen_ai.usage.cache_read.input_tokens >= 0 } | count_over_time()
```

The total is the first result times the second.
