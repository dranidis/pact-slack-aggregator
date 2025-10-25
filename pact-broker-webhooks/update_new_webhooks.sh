set -euxo pipefail

# change SLACK webhook for updates
curl -s -u "$PACT_USER:$PACT_PWD" \
  -H "Content-Type: application/json" \
  -X PUT \
  -d '@update-new.json' \
  $PACT_URL/webhooks/Y-5gAOWqTlyVjOBT46A-XQ

echo

# change slack verifications
curl -s -u "$PACT_USER:$PACT_PWD" \
  -H "Content-Type: application/json" \
  -X PUT \
  -d '@verify-new.json' \
  $PACT_URL/webhooks/iYblcd0Nyb5hEWvwohMC5A

echo "New webhooks updated."
