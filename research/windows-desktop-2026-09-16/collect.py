import hashlib
import json
import re
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MAX_BYTES = 2_000_000


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Clawdeck-source-research"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f"File exceeds collection limit: {url}")
    return data


def collect():
    specification = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))
    records = []
    for project in specification["projects"]:
        if not re.fullmatch(r"[0-9a-f]{40}", project["commit"]):
            raise ValueError("A full pinned commit is required")
        origin = f"https://raw.githubusercontent.com/{project['repository']}/{project['commit']}/"
        license_data = fetch(origin + "LICENSE")
        if b"Permission is hereby granted, free of charge" not in license_data:
            raise ValueError(f"Expected MIT grant missing: {project['repository']}")
        project_root = (ROOT / "upstream" / project["id"]).resolve()
        if not project_root.is_relative_to(ROOT):
            raise ValueError("Invalid project path")
        for relative in project["files"]:
            target = (project_root / relative).resolve()
            if not target.is_relative_to(project_root):
                raise ValueError("Invalid source path")
            data = license_data if relative == "LICENSE" else fetch(origin + relative)
            if target.exists() and target.read_bytes() != data:
                raise ValueError(f"Refusing to replace a changed local reference: {target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            records.append({
                "path": target.relative_to(ROOT).as_posix(),
                "repository": project["repository"],
                "commit": project["commit"],
                "source": f"https://github.com/{project['repository']}/blob/{project['commit']}/{relative}",
                "download": origin + relative,
                "license": project["license"],
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            })
        print(f"Collected {project['repository']}: {len(project['files'])} files", flush=True)
    manifest = {"collectedOn": specification["collectedOn"], "files": records}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Verified collection: {len(records)} files, {sum(row['bytes'] for row in records)} bytes")


if __name__ == "__main__":
    collect()
