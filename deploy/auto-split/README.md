# Deploying the Auto Split service

Auto Split (Beta) is the only part of Pybrix with a server component, and it is optional. The static
site, Repair, Convert and Manual Split do not need it. Architecture and the reasons for each rule:
`docs/adr/0020-auto-split-same-origin-service.md`.

## What it is

A dependency-free Node process (`apps/auto-split-api`, built to one file, `main.js`) that

- accepts `POST /api/auto-split/analyze` with six rendered PNGs, three bounded numbers, a mode and a
  protocol version, and refuses anything else (including any field that looks like a mesh);
- holds the provider key, the pinned prompts and the structured-output schema, none of which the
  browser can supply or see;
- calls the provider's Responses API once, with `store: false` and a strict JSON schema, validates the
  answer, and returns it;
- logs only a request id, the mode, durations, statuses, token counts, an approximate cost and the
  protocol version — never an image, a payload, a header or a key.

It never receives a model file, and it cannot: the request type has no field for one.

## Install

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin cad-fixer-auto-split
npm ci
npm run build --workspace @cadfixer/auto-split-api      # -> apps/auto-split-api/dist/main.js
sudo install -d /opt/cad-fixer-auto-split
sudo install -m 0644 apps/auto-split-api/dist/main.js /opt/cad-fixer-auto-split/main.js
sudo install -d -m 0750 /etc/cad-fixer
sudo install -m 0600 deploy/auto-split/auto-split.env.example /etc/cad-fixer/auto-split.env
# edit /etc/cad-fixer/auto-split.env and enter OPENAI_API_KEY there, on the server, only
sudo install -m 0644 deploy/auto-split/cad-fixer-auto-split.service /etc/systemd/system/
sudo install -m 0644 deploy/nginx/cad-fixer-auto-split.conf /etc/nginx/snippets/
sudo systemctl daemon-reload && sudo systemctl enable --now cad-fixer-auto-split
sudo nginx -t && sudo systemctl reload nginx
```

## Limits

Per client (by the address nginx passes): 8 analyses an hour, 1 at a time. Service-wide: 6 at a time,
**60 provider attempts an hour and 300 a day**, whoever asks. The service-wide windows are in-process
counters: they do not survive a restart, they are not shared between processes (running a second
Auto Split process would double the ceilings), and nothing a request carries can move them. A request
refused for capacity answers 429 `AT_CAPACITY` with a fixed `Retry-After: 600` and no counts. See the
variables in `auto-split.env.example`. At $0.03 a request the ceilings bound request-count exposure at
about $1.80 an hour and $9 a day; they are not a dollar cap, so also set a budget on the provider's project.

## Check

```bash
curl -fsS https://<host>/api/auto-split/health          # {"ok":true,"inFlight":0}
```

The release bundle (`artifacts/release/site`) contains no key, no secret and none of this service. The
service is deployed separately, by the steps above, from a build of the same commit.

## Without it

If the snippet and service are not installed, `/api/auto-split/` is a 404 and Auto Split's Find parts
says the part-finding service is unavailable. Nothing else changes.
