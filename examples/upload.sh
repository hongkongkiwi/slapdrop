#!/usr/bin/env bash
# Usage: SLAPDROP_URL=https://drop.example.com SLAPDROP_TOKEN=... ./examples/upload.sh my-app app-release.apk
set -euo pipefail

: "${SLAPDROP_URL:?Set SLAPDROP_URL}"
: "${SLAPDROP_TOKEN:?Set SLAPDROP_TOKEN}"
slug="${1:?App slug required}"
apk="${2:?APK path required}"
size="$(wc -c < "$apk" | tr -d ' ')"
intent="$(node -e 'console.log(JSON.stringify({ filename: process.argv[1].split("/").pop(), sizeBytes: Number(process.argv[2]) }))' "$apk" "$size")"
response="$(curl --fail-with-body -sS -H "Authorization: Bearer $SLAPDROP_TOKEN" -H 'Content-Type: application/json' -d "$intent" "$SLAPDROP_URL/api/apps/$slug/builds/intent")" || {
  printf 'SlapDrop intent failed:\n%s\n' "$response" >&2
  exit 1
}
id="$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$response")"
url="$(node -e 'console.log(JSON.parse(process.argv[1]).uploadUrl)' "$response")"
curl --fail-with-body -sS -X PUT -H 'If-None-Match: *' --upload-file "$apk" "$url"
build="$(curl --fail-with-body -sS -H "Authorization: Bearer $SLAPDROP_TOKEN" -H 'Content-Type: application/json' -d '{}' "$SLAPDROP_URL/api/builds/$id/complete")" || {
  printf 'SlapDrop publish failed:\n%s\n' "$build" >&2
  exit 1
}
echo "Published: $build"
