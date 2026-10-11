# Auto Split (Beta) — production deployment plan

Status: **planned, not executed.** Written during PYBRIX-08B-RC2 from a rehearsal on the production host
with the unprivileged `pybrix` account; every step below marked `[ROOT]` needs the `luna` administrator
(`pybrix` has no sudo and must not be given any).

## Topology (as found)

- Public site `https://pybrix.com` is the `zz-pybrix` vhost, `root /var/www/cad-fixer/current`
  (Luna-owned release tree, currently `releases/99b30f1…`). `www.pybrix.com` and
  `fixcad.thelunai.com` 301 to `https://pybrix.com/`.
- New material lives under `/srv/pybrix` (`pybrix:pybrix`): `releases/<sha>/`, `shared/`, `tmp/`.
- Runtime identity `pybrix-svc` (nologin, no sudo). Secret `/etc/pybrix/auto-split.env` (root, 0600).
- Server Node is 20.x; the service bundle is verified to run on it.

## Sequence

1. **Verify the artifact.** The tarball's SHA-256 and the manifest's commit equal the release SHA; the
   release was built from a clean tree (`release-manifest.json: workingTreeClean`).
2. **Stage** (pybrix): extract to `/srv/pybrix/releases/<sha>/`, `sha256sum -c SHA256SUMS`, check the
   19 manifest hashes, `chmod -R a-w`. Do not create `current` yet.
3. **Service** `[ROOT]`: key into `/etc/pybrix/auto-split.env` (silent prompt), install
   `pybrix-auto-split.service` (User=pybrix-svc, `UMask=0077`, release path), `daemon-reload`, start.
4. **Loopback checks** (pybrix): `curl 127.0.0.1:8787/api/auto-split/health`; GET analyze → 405;
   raw-mesh POST → 400; journal shows only `start`.
5. **Back up and prepare nginx** `[ROOT]`: `cp zz-pybrix zz-pybrix.pre-autosplit` and install the
   snippet `/etc/nginx/snippets/cad-fixer-auto-split.conf`. The candidate vhost differs from the live one
   in exactly two lines: `root /srv/pybrix/current;` and
   `include /etc/nginx/snippets/cad-fixer-auto-split*.conf;` after the security-headers include.
   `nginx -t` must pass.
6. **Point `current`** (pybrix): `ln -sfn releases/<sha> /srv/pybrix/current` (atomic via `-T` rename).
   Nothing public reads it yet.
7. **Activate** `[ROOT]`: install the candidate vhost and `systemctl reload nginx`.
8. **Public smoke:** `/` 200 with CSP, COOP, COEP, CORP, nosniff, referrer, permissions and frame headers;
   assets 200 with the right types; www and legacy 301; `/api/auto-split/health` 200; other
   `/api/auto-split/*` 404; GET analyze 403.
9. **Browser smoke:** Repair and Manual Split flows with zero `/api/` requests, then one Auto Split
   human analysis (one live request) → suggestion → Preview → Apply → Undo exact.
10. **Monitor** 30 minutes: `journalctl -u pybrix-auto-split` (requests, statuses, tokens, cost), nginx
    error log, restarts (`systemctl show -p NRestarts`).
11. **Roll back immediately** if any stop condition below fires.

## Stop conditions

Roll back at once on any of: site non-200 or broken assets; Repair or Manual Split regression;
Auto Split service unhealthy or restarting repeatedly; any `/api/auto-split/` path other than the two
intended answering; a secret in the browser, the build or any log; loss of any security header or any
change to the CSP; a model changed before an explicit Apply; a malformed provider response reaching the
interface; a stale answer applied to a different model or revision.

## Rollback (no rebuild; seconds)

1. `[ROOT]` `cp zz-pybrix.pre-autosplit zz-pybrix && nginx -t && systemctl reload nginx` — the vhost
   serves `/var/www/cad-fixer/current` again; that release was never modified.
2. `[ROOT]` `systemctl disable --now pybrix-auto-split.service`.
3. `/srv/pybrix/current` may stay; nothing public references it after step 1.

Estimated time: under two minutes, dominated by the two root commands.

## Observability and cost

The service logs, per request: request id, mode, protocol version, durations, HTTP statuses, token
counts and an approximate cost, and refusals including rate-limit and capacity events. No image,
geometry, answer body or file name is ever logged.

**Limits.** Per client: 8 analyses an hour, 1 at a time. Service-wide: 6 at a time, and **60 provider
attempts an hour and 300 a day** whoever asks (`AUTO_SPLIT_GLOBAL_*`). Semantics: an analysis spends one
attempt when it is admitted to the provider, and a retry of a transient failure spends one more (a retry
that finds no room is not made); invalid, cross-origin, wrong-type, raw-mesh, per-client-refused and
busy-refused requests spend nothing; a cancel or a provider error after dispatch does not give the
attempt back. The counters are process-local (**single process**: a second Auto Split process would
double the ceilings), reset when the service restarts (**limit resets on restart**: acceptable for the
beta because only the administrator can restart it, and a crash-looping service is held by systemd's
`StartLimitBurst`), and use no client-supplied value, so forged addresses and forwarding headers cannot move
them. A refusal answers 429 `AT_CAPACITY` with a fixed `Retry-After: 600` and no counts.

**Bound.** At the highest cost seen in qualification ($0.03): 60 × $0.03 = **$1.80 an hour** and
300 × $0.03 = **$9 a day**, in provider attempts. This is a bound on REQUEST COUNT, not a dollar cap and
not a billing guarantee; provider billing can vary. Also set a hard budget on the provider's own project.
