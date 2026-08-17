#!/usr/bin/env bash
# Runs every *.test.js suite. Needs Deno; no other dependencies, no network.
#
#   tests/run.sh          # all suites
#   tests/run.sh explore  # only suites whose name contains "explore"
#   tests/run.sh -v       # show every assertion, not just failures

set -uo pipefail
cd "$(dirname "$0")"

if ! command -v deno >/dev/null 2>&1; then
  echo "deno is required to run the tests: https://deno.land" >&2
  exit 127
fi

verbose=0
filter=""
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) verbose=1 ;;
    *) filter="$arg" ;;
  esac
done

failed=0
ran=0

for suite in *.test.js; do
  [ -e "$suite" ] || continue
  if [ -n "$filter" ] && [[ "$suite" != *"$filter"* ]]; then continue; fi

  ran=$((ran + 1))
  output=$(deno run --allow-read --quiet "$suite" 2>&1)
  status=$?
  passes=$(printf '%s\n' "$output" | grep -c '^PASS' || true)

  if [ $status -eq 0 ]; then
    printf '  \033[32m✓\033[0m %-22s %s checks\n' "${suite%.test.js}" "$passes"
    [ $verbose -eq 1 ] && printf '%s\n' "$output" | sed 's/^/      /'
  else
    failed=$((failed + 1))
    printf '  \033[31m✗\033[0m %-22s\n' "${suite%.test.js}"
    printf '%s\n' "$output" | grep -v '^PASS' | sed 's/^/      /'
  fi
done

echo
if [ "$ran" -eq 0 ]; then
  echo "no suites matched${filter:+ \"$filter\"}"
  exit 1
elif [ "$failed" -eq 0 ]; then
  echo "all $ran suite(s) passed"
else
  echo "$failed of $ran suite(s) failed"
  exit 1
fi
