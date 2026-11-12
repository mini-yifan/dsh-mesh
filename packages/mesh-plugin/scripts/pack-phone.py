#!/usr/bin/env python3
"""Pack the self-contained phone/desktop plugin tarball.

The phone runtime imports a plugin by absolute path and never runs npm install,
so the package must carry the tsdown `bundle/` output plus a package.json whose
entry points at it. Kept dependency-free and deterministic (fixed mtime/uid/gid,
sorted members, gzip mtime=0) so the Android runtime can pin its sha256.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
from pathlib import Path
from typing import NoReturn

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
BUNDLE = PACKAGE / "bundle"
OUT = PACKAGE / "dist-phone"
EPOCH = 1767225600  # 2026-01-01T00:00:00Z, the fixed mtime used by the phone runtime


def fail(message: str) -> NoReturn:
    print(f"pack-phone: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    manifest = json.loads((PACKAGE / "package.json").read_text(encoding="utf-8"))
    name = manifest.get("name")
    version = manifest.get("version")
    if not isinstance(name, str) or not name:
        fail("package.json has no name")
    if not isinstance(version, str) or not version:
        fail("package.json has no version")
    if not (BUNDLE / "index.mjs").is_file():
        fail("bundle/index.mjs is missing; run tsdown first")

    # Every bundled entry and its shared chunks; the bundle directory is exactly
    # what tsdown emits, so a new chunk is picked up without editing this list.
    lib = sorted(path for path in BUNDLE.glob("*.mjs") if path.is_file())
    entries = {path.name for path in lib}
    for required in ("index.mjs", "device-agent.mjs", "return-files.mjs"):
        if required not in entries:
            fail(f"bundle/{required} is missing")
    for path in lib:
        # The Relay-only v0 never loads a native WebRTC backend, but the bundle
        # still carries werift's pure-JS code. Reject actual native artifacts,
        # not references inside the (unused) WebRTC path.
        if path.suffix == ".node":
            fail(f"native artifact in the bundle: {path.name}")

    package_json = {
        "name": name,
        "version": version,
        "description": manifest.get("description", ""),
        "type": "module",
        "main": "./lib/index.mjs",
        "exports": {
            ".": "./lib/index.mjs",
            "./device-agent": "./lib/device-agent.mjs",
            "./return-files": "./lib/return-files.mjs",
            "./package.json": "./package.json",
        },
        "files": ["lib", "dsh-plugin.json", "cordis.patch.yml"],
        "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
    }
    dsh_plugin = {
        "name": name,
        "version": version,
    }

    files: dict[str, bytes] = {
        "package.json": (json.dumps(package_json, ensure_ascii=False, indent=2) + "\n").encode(),
        "dsh-plugin.json": (json.dumps(dsh_plugin, ensure_ascii=False, indent=2) + "\n").encode(),
        "cordis.patch.yml": (PACKAGE / "cordis.patch.yml").read_bytes(),
    }
    for path in lib:
        files[f"lib/{path.name}"] = path.read_bytes()

    OUT.mkdir(parents=True, exist_ok=True)
    tarball = OUT / f"dsh-mesh-plugin-{version}.tgz"
    tmp = tarball.with_suffix(".tgz.tmp")

    def add(tar: tarfile.TarFile, arcname: str, data: bytes) -> None:
        info = tarfile.TarInfo(arcname)
        info.size = len(data)
        info.mtime = EPOCH
        info.mode = 0o644
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        tar.addfile(info, io.BytesIO(data))

    def add_dir(tar: tarfile.TarFile, arcname: str) -> None:
        info = tarfile.TarInfo(arcname)
        info.type = tarfile.DIRTYPE
        info.mtime = EPOCH
        info.mode = 0o755
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        tar.addfile(info)

    with open(tmp, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
                add_dir(tar, "package")
                add_dir(tar, "package/lib")
                for relative in sorted(files):
                    add(tar, f"package/{relative}", files[relative])
    os.replace(tmp, tarball)

    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    print(f"tgz={tarball}")
    print(f"sha256={digest}")
    print(f"version={version}")
    print("entry=lib/index.mjs")
    print(f"files={len(files)}")


if __name__ == "__main__":
    main()