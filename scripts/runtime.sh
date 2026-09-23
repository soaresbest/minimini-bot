#!/usr/bin/env bash
# Funções compartilhadas pelos instaladores e iniciadores Bash (inclusive Bash 3.2).

minimini_node24() {
  local node_file="$1" node_version
  [[ -x "$node_file" ]] || return 1
  node_version="$("$node_file" --version 2>/dev/null)" || return 1
  [[ "$node_version" =~ ^v24\.[0-9]+\.[0-9]+$ ]]
}

minimini_find_node() {
  local runtime_node="$HOME/.minimini-bot/runtime/node/bin/node" system_node
  if minimini_node24 "$runtime_node" && [[ -f "$(dirname "$runtime_node")/npm" ]]; then
    printf '%s\n' "$runtime_node"
    return 0
  fi
  system_node="$(command -v node 2>/dev/null)" || return 1
  if minimini_node24 "$system_node" && [[ -f "$(dirname "$system_node")/npm" ]]; then
    printf '%s\n' "$system_node"
    return 0
  fi
  return 1
}

minimini_verify_checksum() {
  local archive="$1" expected="$2" actual
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive")" || return 1
  else
    actual="$(shasum -a 256 "$archive")" || return 1
  fi
  actual="${actual%% *}"
  [[ "$actual" == "$expected" ]]
}
