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

## Setting up

1. Install: `npm run deploy` builds and copies `main.js` and `manifest.json`
   into the vault. It defaults to `/Volumes/knowledge-base`; override the target
   with `SIMPLE_SYNC_VAULT_PLUGIN_DIR` to deploy to a test vault instead.
2. Fill in server URL, username, password, database. Press **Test connection**.
3. On the first device choose **Push**. Read the dry-run report, then apply.
4. On the next device, use **Show setup QR** from the first one. Scan it with the
   phone's camera — iOS hands the `obsidian://` link to Obsidian, so no scanner
   is needed in the plugin. Then initialize with **Pull** in an empty vault.

The QR contains the server password unencrypted. Do not screenshot it.

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
