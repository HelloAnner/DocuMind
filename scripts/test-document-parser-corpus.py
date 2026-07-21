#!/usr/bin/env python3
import argparse
import hashlib
import json
import subprocess
import tempfile
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tests" / "document-parser-corpus.json"


def download(entry, directory):
    path = directory / entry["name"]
    if not path.exists() or sha256(path) != entry["sha256"]:
        with urllib.request.urlopen(entry["url"], timeout=120) as response:
            path.write_bytes(response.read())
    actual = sha256(path)
    if actual != entry["sha256"]:
        raise RuntimeError(f"checksum mismatch for {path.name}: {actual}")
    return path


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect(paths):
    inspections = []
    for path in paths:
        command = [
            "cargo",
            "run",
            "-q",
            "-p",
            "documind",
            "--example",
            "inspect_document",
            "--",
            str(path),
        ]
        result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        if result.returncode != 0:
            stderr = result.stderr[-8000:].strip()
            inspections.append({"file_name": path.name, "error": stderr})
            continue
        records = [
            json.loads(line)
            for line in result.stdout.splitlines()
            if line.lstrip().startswith("{")
        ]
        if len(records) != 1:
            raise RuntimeError(
                f"inspection for {path.name} returned {len(records)} JSON records"
            )
        inspections.extend(records)
    return inspections


def validate(entries, inspections):
    by_name = {inspection["file_name"]: inspection for inspection in inspections}
    failures = []
    for entry in entries:
        item = by_name.get(entry["name"])
        if item is None:
            failures.append(f"{entry['name']}: inspection missing")
            continue
        expected_error = entry.get("expected_error")
        if expected_error:
            error = item.get("error", "")
            if expected_error not in error:
                failures.append(
                    f"{entry['name']}: expected controlled error {expected_error!r}, got {error!r}"
                )
            else:
                print(f"{entry['name']}: safely rejected with {expected_error}")
            continue
        if "error" in item:
            failures.append(f"{entry['name']}: unexpected parse error: {item['error']}")
            continue
        checks = {
            "file type": item["file_type"] == entry["type"],
            "expected text": entry["contains"].casefold() in item["content"].casefold(),
            "minimum blocks": item["blocks"] >= entry["min_blocks"],
            "minimum tables": item["tables"] >= entry["min_tables"],
            "chunks generated": item["chunks"] > 0,
            "all blocks anchored": item["unanchored_blocks"] == 0,
        }
        failed = [name for name, passed in checks.items() if not passed]
        if failed:
            failures.append(f"{entry['name']}: {', '.join(failed)}")
        print(
            f"{entry['name']}: type={item['file_type']} blocks={item['blocks']} "
            f"tables={item['tables']} chunks={item['chunks']} anchors={item['anchors']} "
            f"quality={item['quality_score']:.3f} warnings={item['warnings']}"
        )
    if failures:
        raise RuntimeError("document corpus validation failed:\n- " + "\n- ".join(failures))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-dir", type=Path)
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    entries = json.loads(MANIFEST.read_text())["sources"]
    temporary = None
    if args.fixture_dir:
        fixture_dir = args.fixture_dir
        fixture_dir.mkdir(parents=True, exist_ok=True)
    else:
        temporary = tempfile.TemporaryDirectory(prefix="documind-parser-corpus-")
        fixture_dir = Path(temporary.name)
    paths = [download(entry, fixture_dir) for entry in entries]
    print(f"fixtures: {fixture_dir}")
    if not args.download_only:
        validate(entries, inspect(paths))
        print(f"document parser corpus passed: {len(paths)} files")
    if temporary:
        temporary.cleanup()


if __name__ == "__main__":
    main()
