# Manual Setup Notes

These actions may require human approval or should be verified manually.

## 1. Authentication

Confirm both CLIs are already authenticated under the intended subscriptions:
- Claude Code / Claude CLI -> Anthropic subscription/account
- Codex CLI -> ChatGPT/Codex subscription/account

Do not insert API keys into this kit unless you explicitly decide to switch to API billing.

## 2. Verify plugin command names locally

Because plugins can update, ask Claude Code to inspect its installed plugin metadata and confirm the exact currently available commands/agents for:
- OpenAI `codex-plugin-cc`
- Anthropic Codex Dispatch
- Anthropic `codex-review`

Expected concepts include:
- task dispatch/delegation to Codex
- code/design review through Codex
- model selection for delegated Codex work
- background/resume support where exposed

If local command names differ from examples in these files, update the Claude role definitions to use the locally installed names.

## 3. Model identifiers

Verify the exact model IDs accepted by your current Codex build for:
- GPT-6 Luna
- GPT-6 Sol (optional)
- GPT-6 Astra

Do not assume display names equal CLI IDs. Let Codex inspect its own available model/config schema and patch the local config fragments accordingly.

## 4. Global config edits

This package intentionally does not overwrite:
- `~/.claude/*`
- `~/.codex/*`
- VS Code settings
- global MCP configuration
- shell profiles

Let each model inspect existing config, propose a minimal patch, and ask you before overwriting or deleting existing settings.

## 5. Git permissions

Recommended default:
- workers may edit files and run checks
- workers may NOT push, merge, force-reset, rewrite history, or alter remotes
- commits only when you explicitly request them

If your existing Codex/Claude permissions are broader, tighten them manually or through the app's permission settings.

## 6. Recommended first validation

Create a disposable repo and run these tests:

A. Claude -> Luna implementation delegation
- Opus creates a task packet.
- Luna implements a small bounded function + tests.
- Opus reviews result.

B. Claude -> Astra independent design review
- Opus creates a small architecture proposal.
- Astra receives only requirements + final proposal.
- Astra critiques it.
- Opus synthesizes revisions.

C. Background/resume
- Launch one longer Codex task in background if supported by your installed plugin.
- Verify Claude can retrieve/resume the result without losing task identity.

D. Permission check
- Deliberately ask a worker to perform a forbidden git action in a disposable repo.
- Confirm the harness blocks or asks for approval.
