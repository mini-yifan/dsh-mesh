# `@dsh-mesh/plugin` build artifacts

The plugin is consumed by two products that **do not build it themselves**:

| Consumer | Takes | Path |
| --- | --- | --- |
| `dsh-orb-cordis` (desktop Orb) | the tsdown `bundle/` | `packages/bundle/vendor/mesh` via `scripts/sync-mesh.mjs` |
| `dsh-orb-android` (phone) | a self-contained tarball | `runtime/.cache/plugins/` via `DSH_PLUGIN_URL` + `DSH_PLUGIN_SHA256` |

Neither consumer can rebuild this package, so the release artifact is the only
thing that actually ships. That makes the version number load-bearing: it is how
a device tells a fixed plugin from a broken one.

## Building

```sh
pnpm --filter @dsh-mesh/mesh build        # src -> dist
cd packages/mesh-plugin
../../node_modules/.bin/tsdown --config tsdown.config.ts   # src -> bundle
pnpm pack:phone                            # bundle -> dist-phone/*.tgz
```

`tsdown` runs from the repository root because the binary lives in the root
`node_modules`; running it from inside this package cannot resolve it.

`pack-phone.py` is deterministic — fixed mtime/uid/gid, sorted members, gzip
mtime 0 — so two runs over the same `bundle/` produce a byte-identical tarball
and a stable sha256. That property is what lets the phone runtime pin the hash.

## Versioning

Bump **both** `package.json` and `dsh-plugin.json` together; the phone runtime
refuses to extract a tarball whose `DSH_PLUGIN_VERSION` disagrees with the
`package.json` inside it.

Keep the artifact for every version a consumer still references. Removing one
turns a pinned build into an unreproducible one.

## What is committed

`dist-phone/dsh-mesh-plugin-<version>.tgz` is committed. `.gitignore` ignores
`*.tgz` globally and re-includes exactly this path, so a stray tarball elsewhere
stays out of the repository.

`bundle/` itself stays ignored: it is a large intermediate that `pack-phone.py`
regenerates from `dist/`, and the tarball is the reviewable artifact.

## Why this changed

Before 0.1.1 the tarball lived only in a local cache. The Host control
connection shipped with `reconnect: false`, so a device that lost its control
socket once stayed unreachable for the rest of the process lifetime. The fix
(0.1.1) existed only as a file copied into two machines' `node_modules`; a clean
checkout, a reinstall or a phone rebuild would have silently reintroduced the
bug. Committing the tarball is what makes the fix survive that.
