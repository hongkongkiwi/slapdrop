#!/usr/bin/env bash
# EAS sets EAS_BUILD_PLATFORM and EAS_BUILD_ARTIFACT_PATH in a post-build hook.
set -euo pipefail

: "${SLAPDROP_URL:?Set SLAPDROP_URL}"
: "${SLAPDROP_TOKEN:?Set SLAPDROP_TOKEN}"
: "${EAS_BUILD_ARTIFACT_PATH:?EAS did not provide APK path}"

apk="$EAS_BUILD_ARTIFACT_PATH"
slug="my-android-app"
size="$(wc -c < "$apk" | tr -d ' ')"
intent="$(node -e 'console.log(JSON.stringify({ filename: process.argv[1].split("/").pop(), sizeBytes: Number(process.argv[2]), create: true, name: "My Android App" }))' "$apk" "$size")"
response="$(curl --fail-with-body -sS -H "Authorization: Bearer $SLAPDROP_TOKEN" -H 'Content-Type: application/json' -d "$intent" "$SLAPDROP_URL/api/apps/$slug/builds/intent")"
id="$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$response")"
url="$(node -e 'console.log(JSON.parse(process.argv[1]).uploadUrl)' "$response")"
curl --fail-with-body -sS -X PUT -H 'If-None-Match: *' --upload-file "$apk" "$url"
curl --fail-with-body -sS -H "Authorization: Bearer $SLAPDROP_TOKEN" -H 'Content-Type: application/json' -d '{}' "$SLAPDROP_URL/api/builds/$id/complete"
