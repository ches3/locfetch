# locfetch

locfetch is an API that retrieves an Android device's location through MacroDroid.

It is designed for cloud-hosted AI agents that use your location to find local information and provide location-based suggestions.

To use it, deploy your own instance to Cloudflare Workers and import the shared MacroDroid template.

## Setup

### MacroDroid

https://www.macrodroidlink.com/macrostore?id=32379

Import the macro from the link above, then configure its local variables:

| Variable      | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| `hostname`    | Your Worker URL (e.g. https://locfetch.username.workers.dev) |
| `token`       | The same value as `MACRODROID_API_TOKEN`                     |
| `request_id`  | No configuration needed                                      |
| `measured_at` | No configuration needed                                      |

### Deployment

Generate a different random value for each of the two tokens.

| Secret                   | Purpose                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `CLIENT_API_TOKEN`       | Authenticates clients requesting location data                                       |
| `MACRODROID_API_TOKEN`   | Authenticates callbacks from MacroDroid                                              |
| `MACRODROID_WEBHOOK_URL` | Your MacroDroid webhook URL (e.g. https://trigger.macrodroid.com/DEVICE_ID/locfetch) |

```sh
pnpm install --frozen-lockfile

pnpm exec wrangler secret put CLIENT_API_TOKEN
pnpm exec wrangler secret put MACRODROID_API_TOKEN
pnpm exec wrangler secret put MACRODROID_WEBHOOK_URL

pnpm deploy
```

## Usage

```sh
curl -H "Authorization: Bearer <CLIENT_API_TOKEN>" https://<worker-hostname>/location
```

```jsonc
{
  "lat": 35.0,
  "long": 139.0,
  "alt": 30, // m
  "accuracy": 20.0, // m
  "speed": 0, // km/h
  "measured_at": "2026-10-19T10:32:10.000Z",
}
```
