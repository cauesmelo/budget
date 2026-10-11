#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  printf 'Install Node.js 22.12 or later from https://nodejs.org/\n'
  exit 1
fi
if [ ! -d node_modules ]; then
  npm ci
fi
npm start
