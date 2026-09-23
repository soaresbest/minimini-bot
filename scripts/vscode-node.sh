#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=runtime.sh
source "$PROJECT_DIR/scripts/runtime.sh"
NODE_FILE="$(minimini_find_node || true)"
if [[ -z "$NODE_FILE" ]]; then
  printf 'Erro: Node.js 24 não encontrado. Pressione F5 novamente para preparar o ambiente.\n' >&2
  exit 1
fi
exec "$NODE_FILE" "$@"
