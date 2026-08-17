# Simple Sync

Syncs an Obsidian vault with a CouchDB server. Five settings, one status-bar
item, no emoji, no wizard, no toasts except real errors.

CouchDB 3 is the server. PouchDB is the client library inside the plugin: it
keeps a local IndexedDB replica and speaks CouchDB's replication protocol, which
is what provides the offline queue and retry behaviour.

## How it works

Three parts, deliberately independent:

1. **Transport** — `PouchDB.sync(local, remote, { live: true, retry: true })`.
2. **Vault to database** — vault events, debounced 1.5 s, write documents.
3. **Database to vault** — a `changes()` feed writes files.

Loop prevention falls out of comparing SHA-256 content hashes rather than
tracking "was this my own write". When part 2 writes a document, part 3 sees the
hash already matches the disk and does nothing. Do not add echo-suppression
state; it is not needed and would be a source of bugs.

One document per file. Text goes in `data`, binaries go in `_attachments`. No
chunking.

## Status bar

One item, icon first, with the file counters (`↑2 ↓1`) beside it while files are
moving. State is carried by colour and icon:

| State | Icon | Colour | Meaning |
| --- | --- | --- | --- |
| off | cloud, crossed out | faint | sync is turned off |
| setup | gear | muted | the vault has not joined yet |
| idle | check in a circle | green | up to date |
| syncing | arrows, spinning | yellow | transferring right now |
| offline | cloud, crossed out | yellow | server unreachable, retrying |
| error | exclamation in a circle | red | sync stopped, see the notice |

`offline` and `idle` are deliberately different: PouchDB pauses replication both
when it has caught up and when it is waiting out a failed request, so a plain
"paused means done" reading would show green while nothing can reach the server.
The spin honours `prefers-reduced-motion`.

## Safety model

The first connect is the dangerous moment: a vault pointed at the wrong database,
or a second device joining with a non-empty vault. Four invariants hold
everywhere:

1. A local file with no document in the database is **never deleted** — only
   uploaded. Pointing at a junk database can therefore add clutter, never lose
   notes.
2. A file is removed only when a tombstone exists **and** the local hash matches
   the hash recorded at deletion. Otherwise it was edited after the remote
   delete: keep it and resurrect the document.
3. Removal always goes through Obsidian's trash, never `adapter.remove`.
4. Overwriting a file whose content was never synced writes a `.conflict-` copy
   first.

And four guards:

- **A — identity.** A `meta:sync` document records which sync group owns the
  database. A mismatch stops sync instead of merging.
- **B — initial mode.** Nothing syncs until you pick Push, Pull, or Merge. Pull
  refuses to run while the vault holds files the database has not seen.
- **C — dry run.** The first reconcile reports what it would do and waits for
  confirmation. This is the plugin's only modal.
- **D — circuit breaker.** More than 20% of the vault (minimum 50 files) about to
  be deleted or overwritten stops sync and asks.

Conflicts never open a dialog. The newest revision wins and the loser is written
beside it as `<name>.conflict-<timestamp>.<ext>`.

## Server requirements

```
chttpd/require_valid_user      true
chttpd/enable_cors             true
cors/credentials               true
cors/origins                   app://obsidian.md, capacitor://localhost, http://localhost
chttpd/max_http_request_size   4294967296
```

`capacitor://localhost` is the iOS origin. Use an **`https://`** URL — a redirect
from `http://` can drop the auth header, and the plugin refuses `http://` for
that reason.

Docker compose service example with Traefik.

`compose.yml`

```yaml
  obsidian:
    image: couchdb:3
    container_name: obsidian
    restart: unless-stopped
    environment:
      - COUCHDB_USER=${COUCHDB_USER}
      - COUCHDB_PASSWORD=${COUCHDB_PASSWORD}
    entrypoint: ["/entrypoint.sh"]
    volumes:
      - obsidian_data:/opt/couchdb/data
      - ./obsidian/local.ini:/opt/couchdb/etc/local.d/local.ini:ro
      - ./obsidian/entrypoint.sh:/entrypoint.sh:ro
    networks:
      - default
    labels:
      traefik.enable: true
      traefik.http.routers.obsidian.rule: Host(`host.example.com`)
      traefik.http.routers.obsidian.entrypoints: websecure
      traefik.http.routers.obsidian.tls.certresolver: cloudflare
      traefik.http.services.obsidian.loadbalancer.server.port: 5984
      traefik.http.routers.obsidian.middlewares: obsidian-cors
      traefik.http.middlewares.obsidian-cors.headers.accesscontrolallowmethods: "GET,PUT,POST,HEAD,DELETE"
      traefik.http.middlewares.obsidian-cors.headers.accesscontrolallowheaders: "accept,authorization,content-type,origin,referer"
      traefik.http.middlewares.obsidian-cors.headers.accesscontrolalloworiginlist: "app://obsidian.md,capacitor://localhost,http://localhost"
      traefik.http.middlewares.obsidian-cors.headers.accesscontrolmaxage: 3600
      traefik.http.middlewares.obsidian-cors.headers.accesscontrolallowcredentials: true
      traefik.http.middlewares.obsidian-cors.headers.addvaryheader: true
      traefik.docker.network: example_default
```

`./obsidian/entrypoint.sh`

```bash
#!/bin/bash
# Write admin credentials to docker.ini so local.ini can stay read-only and secret-free
if [ -n "$COUCHDB_USER" ] && [ -n "$COUCHDB_PASSWORD" ]; then
  printf '[admins]\n%s = %s\n' "$COUCHDB_USER" "$COUCHDB_PASSWORD" > /opt/couchdb/etc/local.d/docker.ini
fi
# Skip the default entrypoint's chown/chmod (fails on read-only mounts)
# and start CouchDB directly as couchdb user
chown -f couchdb:couchdb /opt/couchdb/etc/local.d/docker.ini
exec setpriv --reuid=couchdb --regid=couchdb --clear-groups /opt/couchdb/bin/couchdb
```

`./obsidian/local.ini`

```ini
[couchdb]
single_node = true
max_document_size = 50000000

[cluster]
n = 1

[chttpd]
require_valid_user = true
max_http_request_size = 4294967296
enable_cors = true
bind_address = 0.0.0.0

[chttpd_auth]
require_valid_user = true
authentication_redirect = /_utils/session.html

[httpd]
WWW-Authenticate = Basic realm="couchdb"
bind_address = 0.0.0.0
enable_cors = true

[cors]
credentials = true
headers = accept, authorization, content-type, origin, referer
methods = GET, PUT, POST, HEAD, DELETE
origins = app://obsidian.md, capacitor://localhost, http://localhost
```

## Installing

### Desktop

`npm run deploy` builds and copies `main.js`, `manifest.json` and `styles.css`
into the vault. It defaults to `/Volumes/knowledge-base`; override the target
with `SIMPLE_SYNC_VAULT_PLUGIN_DIR` to deploy to a test vault instead.

### iOS and Android, through BRAT

The plugin is not in the community catalogue, and a phone has no filesystem to
copy a build into. [BRAT](https://github.com/TfTHacker/obsidian42-brat) installs
and updates plugins straight from GitHub releases, which is the only practical
route on mobile.

1. In Obsidian on the phone: **Settings → Community plugins → Browse**, install
   **BRAT**, enable it.
2. **Settings → BRAT → Add beta plugin**, paste
   `https://github.com/asiryk/obsidian-simple-sync`, keep "latest version", add.
3. Enable **Simple Sync** under Community plugins.

BRAT then updates the plugin whenever a new release is tagged. Mobile Obsidian
uses the `capacitor://localhost` origin, so the CORS list above must include it
or every request fails before it reaches CouchDB.

## Setting up

1. Fill in server URL, username, password, database. Press **Test connection**.
2. On the first device choose **Push**. Read the dry-run report, then apply.
3. On the next device, use **Show setup QR** from the first one. Scan it with the
   phone's camera — iOS hands the `obsidian://` link to Obsidian, so no scanner
   is needed in the plugin. Then initialize with **Pull** in an empty vault.

The QR contains the server password unencrypted. Do not screenshot it.

The password itself is kept in Obsidian's secret storage (`app.secretStorage`),
which encrypts it with the system keychain, and is left out of the plugin's
`data.json` entirely. A password left in `data.json` by an earlier version is
moved across on the next load. `minAppVersion` is 1.11.4 for this reason: that is
the release the API landed in. A platform with no secure backend underneath it
still falls back to `data.json`, because the alternative is not keeping the
password at all.

## Development

```
npm install
npm run dev        # watch build
npm run build      # production bundle
npm run deploy     # build, then copy into the vault
npm run check      # typecheck + lint + tests
```

TypeScript 7 for typechecking (esbuild does the transpiling), Biome for lint and
format, Vitest for tests.

### Releasing

BRAT reads `manifest.json` from the release assets and compares its version to
the tag, so the two must agree. `npm version` keeps them in step:

```
npm version patch    # or minor / major
git push --follow-tags
```

`npm version` first runs `preversion.mjs`, which fetches tags and refuses a
version that is already tagged here or on the server — it runs before anything is
rewritten, so a rejected bump leaves nothing to clean up. Then `version-bump.mjs`
writes the new version into `manifest.json` and records it in `versions.json`,
and stages both. Tags carry no `v` prefix (`.npmrc` sets `tag-version-prefix=""`).

Pushing the tag runs `.github/workflows/release.yml`: it checks, builds, refuses
to continue if the tag and `manifest.json` disagree, and publishes a release with
`main.js`, `manifest.json` and `styles.css` attached. `main.js` is a build
artifact and stays out of git; only the release carries it.

### Tests

`npm test` runs unit tests against an in-memory PouchDB and a fake vault adapter.
They cover the reconcile decision matrix, all four invariants, the guards, the
stale-versus-diverged distinction, and the ignore-list semantics.

`npm run test:live` runs the integration suite against a real CouchDB. It creates
and drops its own database and refuses to run against one whose name contains
"knowledge":

```
SYNC_TEST_URL=https://couchdb.example.net \
SYNC_TEST_USER=admin \
SYNC_TEST_PASS=... \
SYNC_TEST_DB=sync_test \
npm run test:live
```

## Deliberately not included

`.obsidian/` sync (Obsidian's vault events do not fire for dotfolders, which is
why doing it properly costs thousands of lines), chunking, end-to-end encryption,
path obfuscation, peer-to-peer sync, S3 backends, plugin sync, document history,
and internationalisation.
