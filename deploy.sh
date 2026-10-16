#!/usr/bin/env bash
# Deploy (fresh install or update) the orchestration kit into this Linux/WSL user's ~/.claude.
# Author: maintained with Claude Code for the frontier-model orchestration setup.
#
# Steps: find Node >= 18 (non-interactive WSL shells often skip ~/.bashrc and still see the
# distro's old /usr/bin/node, so user-level installs are probed: $NODE_BIN_DIR, pnpm, Volta,
# nvm) -> prompt-freeze check (prompts must stay
# byte-identical during the evaluation period) -> claude/global/install.mjs, which replaces every
# kit-managed file under ~/.claude/orchestration, the two subagents, the managed CLAUDE.md block
# and the permission rules (backing up CLAUDE.md and settings.json first). runs/ and telemetry/
# are never touched. Fresh installs and updates use the same path.
#
#   ./deploy.sh                        install / update
#   ./deploy.sh --check                preflight only, changes nothing
#   ./deploy.sh --dry-run              show what would change
#   ./deploy.sh --allow-prompt-change  skip the prompt-freeze check (only after the evaluation closes)
#   ./deploy.sh --uninstall [--purge]  remove the kit (--purge also deletes runs/ and telemetry/)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$REPO_ROOT/claude/global/install.mjs"
PROMPT_FREEZE="$REPO_ROOT/claude/global/test/prompt-freeze.mjs"
MINIMUM_NODE_MAJOR=18

check_only=false; dry_run=false; allow_prompt_change=false; uninstall=false; purge=false
for arg in "$@"; do
  case "$arg" in
    --check) check_only=true ;;
    --dry-run) dry_run=true ;;
    --allow-prompt-change) allow_prompt_change=true ;;
    --uninstall) uninstall=true ;;
    --purge) purge=true ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "deploy.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

# Input: none. Output: prints the node major version, or nothing when node is absent.
node_major() {
  command -v node >/dev/null 2>&1 || return 0
  node --version | sed 's/^v//; s/\..*//'
}

# Input: none. Output: exit status 0 when the node on PATH is >= MINIMUM_NODE_MAJOR.
node_is_recent() {
  local major
  major="$(node_major)"
  [[ -n "$major" && "$major" -ge "$MINIMUM_NODE_MAJOR" ]]
}

# Input: none. Output: none; puts a recent node first on PATH, or exits 1 when none is found.
ensure_node() {
  local dir
  if ! node_is_recent; then
    for dir in "${NODE_BIN_DIR:-}" "${PNPM_HOME:-$HOME/.local/share/pnpm}/bin" "${PNPM_HOME:-$HOME/.local/share/pnpm}" \
               "${VOLTA_HOME:-$HOME/.volta}/bin"; do
      if [[ -n "$dir" && -x "$dir/node" ]]; then
        PATH="$dir:$PATH"
        node_is_recent && break
      fi
    done
  fi
  if ! node_is_recent && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # nvm.sh references unset variables; relax nounset only while it loads.
    set +u
    # shellcheck disable=SC1091
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    set -u
  fi
  if ! node_is_recent; then
    echo "deploy.sh: Node.js $MINIMUM_NODE_MAJOR+ is required (found: $(node --version 2>/dev/null || echo none))." >&2
    exit 1
  fi
  echo "node $(node --version) ($(command -v node))"
}

# Input: step label, then node arguments. Output: none; exits on failure (set -e).
node_step() {
  local label="$1"; shift
  echo "== $label"
  node "$@"
}

ensure_node
commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
[[ -n "$commit" ]] && echo "kit commit $commit"

if $uninstall; then
  uninstall_args=("$INSTALLER" --uninstall)
  $purge && uninstall_args+=(--purge)
  $dry_run && uninstall_args+=(--dry-run)
  node_step "uninstall" "${uninstall_args[@]}"
  exit 0
fi

if $check_only; then
  node_step "preflight" "$INSTALLER" --check
  exit 0
fi

if $allow_prompt_change; then
  echo "WARNING: prompt-freeze check skipped (--allow-prompt-change)." >&2
else
  node_step "prompt freeze" "$PROMPT_FREEZE"
fi

install_args=("$INSTALLER")
$dry_run && install_args+=(--dry-run)
node_step "install" "${install_args[@]}"

if ! $dry_run; then
  node_step "effective model selection" "$HOME/.claude/orchestration/scripts/codex-delegate.mjs" models
  echo "Deployed. Start a NEW Claude Code session so the agents and CLAUDE.md block reload."
fi
