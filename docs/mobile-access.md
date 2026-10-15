# Mobile access: hardening and event stream

Expands item 1 of [`fleet-roadmap.md`](fleet-roadmap.md). Goal: use the web
UI from a phone (Inbox, PR board, one terminal at a time) over Tailscale,
then decide whether a native Android app is worth building.

Out of scope: a native app, multi-user accounts, anything exposed beyond the
tailnet.

## 1. Hardening the web server

Tailscale is the network boundary and we rely on it. It isn't sufficient on
its own, because the API executes arbitrary commands and the tailnet also
contains other devices and any browser running on them.

### Bind address

`packages/gui/src/web/server/index.ts` hard-codes `127.0.0.1`. Add
`BESIEGE_WEB_HOST`:

- default stays `127.0.0.1`;
- the documented remote setup keeps `127.0.0.1` and fronts it with
  `tailscale serve` (gives HTTPS, which Web Push and service workers need);
- binding a tailnet IP directly is allowed; `0.0.0.0` is refused unless
  `BESIEGE_WEB_ALLOW_ANY=1`, so a LAN exposure is never an accident.

### Origin and Host checks

Applied to every HTTP request and every WebSocket upgrade (including the
terminal stream in `ws-proxy.ts`):

- `Host` must match an allowlist (`localhost`, `127.0.0.1`, and the names in
  `BESIEGE_WEB_ALLOWED_HOSTS`, e.g. `krukoffice.tailnet.ts.net`). Defeats DNS
  rebinding.
- Requests with an `Origin` header must have an origin whose host is on the
  same allowlist. Defeats cross-site requests from a page open on a tailnet
  device. Non-browser clients send no `Origin` and pass.
- State-changing routes reject `GET`.

### Identity

When behind `tailscale serve`, the proxy sets `Tailscale-User-Login`. Add
`BESIEGE_WEB_ALLOWED_USERS` (comma-separated logins). If set, requests
without a matching header get 403. The header is only trusted when the
connection comes from the loopback address, since anything else could forge
it.

Fallback for setups without `tailscale serve`: the control plane's token
typed once and stored in an `HttpOnly`, `SameSite=Strict` cookie. Not needed
for v1 if the header path works.

### Tailnet ACL (documentation only)

Recommend an ACL that allows only the user's phone and work machines to reach
the web port. No code.

### Tests

- Host/Origin allowlist: allowed, wrong host, wrong origin, no origin.
- Identity header: allowed user, other user, header from a non-loopback peer.
- Bind refusal for `0.0.0.0`.
- WebSocket upgrade goes through the same checks as HTTP.

## 2. Event stream

Clients poll today (see the README's "update model" note). Polling is wrong
for a phone: it wastes battery and can't notify a closed app.

### Server-sent events

Add `GET /events` on the daemon (and proxy it through the web server):

- `text/event-stream`, one stream per client.
- Event types, starting with what the Inbox needs: `inbox.created`,
  `inbox.acknowledged`, `session.state` (running, blocked, exited),
  `pr.updated` (after a sync).
- Each event has a monotonically increasing id, taken from a small
  `events` table in SQLite (id, type, payload, created_at), pruned by age.
  Clients reconnect with `Last-Event-ID` and get what they missed, so a
  phone that slept doesn't lose events.
- Payloads are small and carry ids, not full rows. Clients refetch the
  affected resource.
- On a fleet, the control plane owns the stream and followers forward their
  events to it, the same path as heartbeats.

SSE over WebSocket because it is one-directional, reconnects natively, and
works through `tailscale serve` without special handling. Terminal streams
stay on WebSocket.

### Web Push

Once the stream exists, notify a closed PWA:

- Service worker plus a Web Push subscription stored per device in the
  daemon DB (`push_subscriptions`: endpoint, keys, user agent, created_at).
- The daemon sends a push for `inbox.created` where the item needs the user
  (blocked or waiting), not for every event.
- VAPID keys generated on first run, persisted like the TCP token.
- Requires HTTPS, so it depends on `tailscale serve`.

Push payloads go through the browser vendor's push service, so they carry
only an id and a short generic title ("Agent needs you"), never repo names,
prompts, or output.

## 3. Mobile layout

Tracked in the roadmap; listed here for ordering. Inbox first, session list,
one terminal at a time, a prompt box that sends text plus Enter, and
approve/deny for permission prompts.

## Order of work

1. `BESIEGE_WEB_HOST`, Host/Origin checks, identity allowlist, tests, README
   section.
2. `events` table and `GET /events` with `Last-Event-ID`; switch the GUI's
   Inbox from polling to the stream.
3. Mobile layout, PWA manifest and service worker.
4. Web Push.

Native Android is reconsidered after step 4, only if the PWA can't deliver
something we actually need (for example approving from the notification
shade, or reliable delivery with the browser closed).

## Open questions

- Is the identity header enough, or do we want the cookie token anyway for
  access from a machine that isn't on `tailscale serve`?
- Retention for the `events` table: age-based, or capped by row count?
- Should approve/deny be allowed from a push notification action, or only
  inside the app? Notification actions can't show what is being approved.
