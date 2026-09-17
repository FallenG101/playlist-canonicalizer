#!/bin/zsh

set -e

project_dir="$(cd "$(dirname "$0")" && pwd)"
bundled_node="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

cd "$project_dir"

if command -v node >/dev/null 2>&1; then
  node server.mjs
elif [[ -x "$bundled_node" ]]; then
  "$bundled_node" server.mjs
else
  echo "Canonicalizer needs Node.js 20 or newer."
  echo "Install Node.js from https://nodejs.org and run this file again."
  read "?Press Return to close."
fi
