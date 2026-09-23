#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=runtime.sh
source "$PROJECT_DIR/scripts/runtime.sh"

printf 'Preparando o Minimini Bot para execução pelo VS Code...\n'
NODE_FILE="$(minimini_find_node || true)"
if [[ -z "$NODE_FILE" ]]; then
  printf 'Node.js 24 não foi encontrado. O instalador completo será executado agora.\n'
  bash "$PROJECT_DIR/install.sh" --yes --no-start
  NODE_FILE="$(minimini_find_node || true)"
  [[ -n "$NODE_FILE" ]] || { printf 'Erro: o Node.js 24 não ficou disponível após a instalação.\n' >&2; exit 1; }
fi

export PATH="$(dirname "$NODE_FILE"):$PATH"
cd -- "$PROJECT_DIR"
printf 'Node.js encontrado: %s\n' "$("$NODE_FILE" --version)"
printf 'Verificando todas as dependências do package.json...\n'

NEEDS_INSTALL=0
if [[ ! -f node_modules/.package-lock.json ]]; then
  NEEDS_INSTALL=1
elif [[ package.json -nt node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  NEEDS_INSTALL=1
elif ! npm ls --all --silent >/dev/null 2>&1; then
  NEEDS_INSTALL=1
fi

if [[ "$NEEDS_INSTALL" == 1 ]]; then
  printf 'Dependências ausentes, inválidas ou desatualizadas. Executando npm ci...\n'
  npm ci --no-fund --no-audit
  npm ls --all --silent >/dev/null
  printf 'Todas as dependências foram instaladas e validadas.\n'
else
  printf 'Todas as dependências já estão instaladas e válidas.\n'
fi

printf 'Preparação concluída. O bot será aberto no terminal integrado do VS Code.\n'
