#!/usr/bin/env bash
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$PROJECT_DIR/install.sh" "$@"
INSTALL_RESULT=$?
if [[ -t 0 ]]; then
  printf '\nPressione Enter para fechar esta janela. '
  IFS= read -r _ || true
fi
exit "$INSTALL_RESULT"
