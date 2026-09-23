#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runtime.sh
source "$PROJECT_DIR/scripts/runtime.sh"
NODE_FILE="$(minimini_find_node || true)"
if [[ -z "$NODE_FILE" ]]; then
  printf 'Node.js 24 não encontrado. Execute: bash "%s/install.sh"\n' "$PROJECT_DIR" >&2
  exit 1
fi
if [[ ! -d "$PROJECT_DIR/node_modules/mineflayer" ]]; then
  printf 'Dependências ausentes. Execute: bash "%s/install.sh"\n' "$PROJECT_DIR" >&2
  exit 1
fi
export PATH="$(dirname "$NODE_FILE"):$PATH"
cd -- "$PROJECT_DIR"
exec "$NODE_FILE" "$PROJECT_DIR/src/index.js" "$@"
