---
'@marcusrbrown/infra': minor
---

Add `cliproxy login codex` for onboarding ChatGPT Pro accounts via the device-code OAuth flow. Extends the existing `cliproxy login <provider>` command to accept `codex` alongside `claude`, mapped to the upstream CLIProxyAPI `--codex-device-login` flag. Before establishing SSH, the command emits an anti-phishing notice instructing the operator to verify the device-code URL points to `openai.com`.

The login action now exports a named `cliproxyLoginAction` function with an injectable SSH-spawn dependency, replacing the prior inline closure. Production callers are unchanged; tests invoke the action directly with mocked spawn. Provider validation uses `Object.prototype.hasOwnProperty.call()` to reject prototype-chain keys (`__proto__`, `constructor`, `hasOwnProperty`).
