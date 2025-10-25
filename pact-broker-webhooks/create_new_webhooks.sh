
set -euxo pipefail

# change SLACK webhook for updates
curl -u "$PACT_USER:$PACT_PWD" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '@update-new.json' \
  $PACT_URL/webhooks/

# change slack verifications
curl -u "$PACT_USER:$PACT_PWD" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '@verify-new.json' \
  $PACT_URL/webhooks/

