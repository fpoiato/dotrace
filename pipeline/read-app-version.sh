#!/bin/sh
# Prints the version string from the Angular production environment.
# The pipeline appends the source revision after this value.
set -eu
file=${1:-frontend/dotrace-app/src/environments/environment.prod.ts}
version=$(sed -n "s/^[[:space:]]*version: ['\"]\([^'\"]*\)['\"].*/\1/p" "$file")
if [ -z "$version" ]; then
  echo "Missing version in $file" >&2
  exit 1
fi
printf '%s\n' "$version"
