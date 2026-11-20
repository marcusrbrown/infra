---
title: Trace collection privacy
description: What the self-hosted trace collection stack receives, where it keeps it, who can read it and how long it lives.
---

This page describes what happens to data that agent runs send to the self-hosted trace collection stack.

**Not yet live.** The stack is not deployed. No sender token has been issued and no trace has been collected. This page is published before any token is issued, and it will be updated if anything below changes.

This is a single-operator deployment. The person who runs the stack and the person who reads the traces are the same party. There are no end users, no third-party recipients, no analytics and no advertising.

## Who sends traces

Agent runs in the operator's own repositories and organisation, and the operator's own workstation. Each of those three senders has its own group and its own token. Nobody else is given a token.

## What a trace contains

A trace records one agent run. It holds the prompts, the model output, the tool calls with their inputs and results, and the run identity (the sender group, the repository and the run ID).

A trace can therefore contain anything the agent read or produced during the run. That includes source code, and it includes secrets and other people's text if they appeared in a file, a command's output or an issue the agent read. Nothing removes them before storage.

## Where it is stored

On one self-hosted host, in two stores:

- **Langfuse** holds every trace in full, content included.
- **Tempo** holds structure only: the operation, provider and model, token counts, finish reasons, tool names and call IDs, the agent and session names, the run identity fields, error types, the sender group, span names, status messages and exception messages. Span names and messages are free text. A tool's error can quote a command line, a path or part of a prompt, so Tempo is not content-free. Attributes on span links are kept as sent, up to Tempo's per-attribute size limit. If a sender puts content in a link attribute, Tempo holds that content.

The data volume is encrypted at rest by the hosting provider. The provider holds the keys. That protects lost or reused disks. It does not protect against someone who has control of the running host.

## Who can read it

Only the operator, and only over SSH to the host. Langfuse and Grafana are not published: they listen on the host's loopback address and are reached through an SSH tunnel. The only public endpoint is the ingest path, which accepts traces and reads nothing back, and a health path that answers one word. No third-party service receives trace data.

## How long it is kept

The target is 30 days live. A daily snapshot of the volume can hold a trace for up to 8 more days, so the target for the longest a trace exists is 38 days.

These are targets, not guarantees. A delayed database merge or a failed snapshot prune can keep data longer, and a backup made outside this routine would extend it further. The stack checks the age of its oldest data and raises an alert when it passes 31 days.

## Deleting data

The operator can delete a trace from Langfuse on request. Tempo has no way to delete one trace. Its copy (structure, names, error text and link attributes) expires with the 30-day retention, unless the operator wipes the whole Tempo store. A snapshot that contains the data ages out within 8 days of the deletion.

## Calls the software makes on its own

Telemetry and update checks are turned off wherever the software has a setting for them. One call has no setting: when the Langfuse web interface loads, it checks for an update. Loading the interface also makes the operator's browser fetch a small number of badge and asset files. No other outbound call is known.

## Questions or removal requests

Open an issue at [github.com/marcusrbrown/infra/issues](https://github.com/marcusrbrown/infra/issues). Do not put trace content in it.
