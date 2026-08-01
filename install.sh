#!/bin/sh
set -e

REQUIRED_NODE_MAJOR=22

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js ${REQUIRED_NODE_MAJOR}+ is required. Install it from https://nodejs.org" >&2
  exit 1
fi

node_major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [ "$node_major" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "error: Node.js ${REQUIRED_NODE_MAJOR}+ is required (found $(node --version))" >&2
  exit 1
fi

echo "installing @marshall/cli..."
if ! npm install -g @marshall/cli; then
  echo "" >&2
  echo "error: global install failed." >&2
  echo "  - If the package was not found, it may not be published yet — see the README for running from source." >&2
  echo "  - If it was a permissions error (EACCES), use a node version manager (nvm, fnm, mise)" >&2
  echo "    rather than sudo: https://docs.npmjs.com/resolving-eacces-permissions-errors" >&2
  exit 1
fi

echo ""
echo "marshall installed. Run 'marshall' to get started."
echo ""
echo "First run walks you through picking a provider and model, and asks for an"
echo "API key if one isn't already in your environment (e.g. ANTHROPIC_API_KEY,"
echo "OPENROUTER_API_KEY). 'marshall login' also works for Claude."
