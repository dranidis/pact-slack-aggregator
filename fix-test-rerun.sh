#!/usr/bin/env bash
set -e

TARGET_FILE=$(find node_modules -path "*/@cloudflare/vitest-pool-workers/dist/pool/index.mjs" 2>/dev/null | head -n 1)

if [[ -z "$TARGET_FILE" ]]; then
  echo "❌ index.mjs not found in @cloudflare/vitest-pool-workers/dist/pool"
  exit 1
fi

echo "🔍 Found: $TARGET_FILE"

# DOES NOT WORK BECAUSE THE LINE ALREADY EXISTS IN THE FILE SOMEWHERE ELSE
# # Check if the line already exists
# if grep -q 'forEachMiniflare(project\.mf, (mf) => mf\.setOptions(mfOptions))' "$TARGET_FILE"; then
#   echo "✅ Line already exists. No changes made."
#   exit 0
# fi

# Insert after the debug log line
TMP_FILE=$(mktemp)
awk '
  /log2\.debug\(`Reusing runtime for \$\{project\.relativePath\}\.\.\.`\);/ {
    print $0;
    print "      await forEachMiniflare(project.mf, (mf) => mf.setOptions(mfOptions));";
    next;
  }
  { print $0; }
' "$TARGET_FILE" > "$TMP_FILE"

mv "$TMP_FILE" "$TARGET_FILE"

echo "✅ Line inserted successfully."
