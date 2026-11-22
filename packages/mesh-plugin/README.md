# `@dsh-mesh/plugin` build artifacts

The plugin is consumed by two products that **do not build it themselves**:

| Consumer | Takes | Path |
| --- | --- | --- |
| `dsh-orb-cordis` (desktop Orb) | the unpacked tsdown `bundle/` | `packages/bundle/vendor/mesh` via `scripts/sync-mesh.mjs` |
| `dsh-orb-android` (phone) | the self-contained tarball | injected into the PRoot rootfs by `runtime/lib/repack-rootfs.py` |

Neither consumer can rebuild this package, so the release artifact is the only
thing that actually ships. That makes the version number load-bearing: it is how
a device tells a fixed plugin from a broken one.

**Bumping the version is not enough to ship it.** After `pnpm pack:phone` you
must push the new tarball into both consumers, or they keep shipping the old
plugin with no error:

```sh
# desktop: copy vendor/mesh from the newest tarball
cd ../../dsh-orb-cordis/packages/bundle && node scripts/sync-mesh.mjs

# phone: rebuild the runtime rootfs with the new tarball
#   see ../../../dsh-orb-android/docs/phone-device-testing.md §2.2
```

`sync-mesh.mjs` picks the highest version in `dist-phone/`, so a stale
`vendor/mesh` is silent: `assemble.mjs` happily packages it. Confirm with
`diff -rq` against the tarball's `package/lib/`.

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

Both consumers record this version too: the desktop device reports it from the
installed plugin, and the phone folds it into `runtimeVersion` so a plugin
change alone triggers the runtime upgrade.

Keep the artifact for every version a consumer still references. Removing one
turns a pinned build into an unreproducible one.

## What is committed

`dist-phone/dsh-mesh-plugin-<version>.tgz` is committed. `.gitignore` ignores
`*.tgz` globally and re-includes exactly this path, so a stray tarball elsewhere
stays out of the repository.

`bundle/` itself stays ignored: it is a large intermediate that `pack-phone.py`
regenerates from `dist/`, and the tarball is the reviewable artifact.

## Two copies of the Agent prompt

The tools and the prompt that tells an Agent when to use them live in different
places, and both must change together:

| Layer | Where |
| --- | --- |
| tool registration | `src/device-agent.ts` (this repo) |
| desktop prompt | `dsh-orb-cordis/packages/bundle/cordis.patch.yml` |
| phone bridge prompt | `dsh-orb-android/runtime/bridge/dsh-go-bridge/cordis.patch.yml` |

A tool nobody is told about is a tool that never gets called. 0.1.6 added
`device_agent_devices` and touched all three.

## Why this changed

Before 0.1.1 the tarball lived only in a local cache. The Host control
connection shipped with `reconnect: false`, so a device that lost its control
socket once stayed unreachable for the rest of the process lifetime. The fix
(0.1.1) existed only as a file copied into two machines' `node_modules`; a clean
checkout, a reinstall or a phone rebuild would have silently reintroduced the
bug. Committing the tarball is what makes the fix survive that.

0.1.3 also fixes the phone's `/.dsh-mesh/v1/*` routes. The phone loads this
plugin as an app-level module, whose Cordis Context has no `connection`
service; `registerMeshRoutes` therefore saw `undefined`, failed closed and
returned 401 "This request is not authenticated." for every request, so the
phone's Interconnect page showed no server and no peers even though the engine
was paired and all three devices were online. The guard now falls back to the
webServer's Context, resolved **per request**: that service is registered
asynchronously and is still absent at plugin-registration time.

0.1.4 let a paired device continue any normal remote session, not only the
task sessions `device_agent` created; tasks keep a `taskId` so "stop all" still
targets them.

0.1.5 added remote session creation (`POST /sessions/<node>/create`) and made
workspaces collapsible in both UIs.

0.1.6 is the "computer cannot wake the phone" fix. `device_agent` used to pick
a workspace by guessing and fail with a bare reason, so a phone that had never
registered a workspace simply could not be dispatched to. It now ships
`device_agent_devices` (paired devices, online state, their workspaces),
reports `catalog_read_failed` / `needs_workspace` with the available workspace
list, retries a remote catalog read twice with a 15s timeout, and on Android
boots a `default-workspace` at `/root/workspace` when the engine has none.

