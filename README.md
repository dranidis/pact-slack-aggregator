## Deploy

```
wrangler deploy
```

## Watch logs

```
wrangler tail pact-slack-aggregator
```

## Test sending a payload

```
curl -X POST https://psa.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "provider_verification_published",
    "providerName": "APIx",
    "githubVerificationStatus": "success",
    "verificationResultUrl": "https://example.com/101",
    "consumerName": "UIx1",
    "consumerVersionBranch": "feature/x",
    "providerVersionBranch": "master"
  }'
```
