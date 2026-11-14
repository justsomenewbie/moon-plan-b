"""Compare the tracked frontend extract with a local producer OpenAPI snapshot.

Run from the repository root: python3 -m qa.check_producer_openapi /path/to/openapi.json
A difference means the extract needs review. Additive changes inside its scope also count.
"""
import argparse
import json
from pathlib import Path
import sys

EXTRACT = Path(__file__).resolve().parents[1] / "contracts/openapi.dataset.json"
HTTP_METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
OMIT_SCHEMA_EXAMPLES = {"CreateJobRequest", "Job", "JobAccepted", "Problem"}


def component_refs(value):
    if isinstance(value, dict):
        if "$ref" in value:
            ref = value["$ref"]
            if not isinstance(ref, str) or not ref.startswith("#/components/"):
                raise ValueError("unsupported reference in scoped contract; review the extract")
            parts = ref.split("/")
            if len(parts) < 4:
                raise ValueError("incomplete component reference in scoped contract")
            yield parts[2], parts[3]
        for child in value.values():
            yield from component_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from component_refs(child)


def scoped_contract(producer, tracked):
    paths = {}
    inherits_security = False
    for path, tracked_item in tracked["paths"].items():
        methods = tracked_item.keys() & HTTP_METHODS
        if not methods:
            raise ValueError(f"no scoped HTTP method at {path}")
        if path not in producer["paths"]:
            raise ValueError(f"missing producer path: {path}")
        item = producer["paths"][path]
        scoped_item = {}
        for method in sorted(methods):
            if method not in item:
                raise ValueError(f"missing producer operation: {method.upper()} {path}")
            scoped_item[method] = item[method]
            inherits_security |= "security" not in item[method]
        # Path-level declarations also apply to the included methods.
        for key in ("parameters", "servers", "summary", "description", "$ref"):
            if key in item:
                scoped_item[key] = item[key]
        paths[path] = scoped_item
    if not paths:
        raise ValueError("the frontend extract contains no paths")

    components = {}
    pending = set(component_refs(paths))
    while pending:
        kind, name = pending.pop()
        group = components.setdefault(kind, {})
        if name in group:
            continue
        try:
            value = producer["components"][kind][name]
        except KeyError as exc:
            raise ValueError(f"unresolved producer component: {kind}/{name}") from exc
        if kind == "schemas" and name in OMIT_SCHEMA_EXAMPLES:
            value = {key: child for key, child in value.items() if key != "examples"}
        group[name] = value
        pending.update(component_refs(value))

    result = {
        "openapi": producer["openapi"],
        "info": {key: producer["info"][key] for key in ("title", "version")},
        "paths": paths,
        "components": components,
    }
    if producer.get("security") and inherits_security:
        result["security"] = producer["security"]
    return result


def compare(tracked, producer, location="$"):
    if isinstance(tracked, dict) and isinstance(producer, dict):
        for key in sorted(tracked.keys() | producer.keys()):
            child = f"{location}/{key}"
            if key not in tracked or key not in producer:
                raise ValueError(f"contract drift at {child} (field added or removed)")
            compare(tracked[key], producer[key], child)
    elif isinstance(tracked, list) and isinstance(producer, list):
        if len(tracked) != len(producer):
            raise ValueError(f"contract drift at {location} (array length changed)")
        for index, (old, new) in enumerate(zip(tracked, producer)):
            compare(old, new, f"{location}/{index}")
    elif tracked != producer or isinstance(tracked, bool) != isinstance(producer, bool):
        raise ValueError(f"contract drift at {location} (value changed)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("producer", type=Path, help="Local producer OpenAPI JSON file")
    args = parser.parse_args()
    try:
        producer = json.loads(args.producer.read_text(encoding="utf-8"))
        tracked = json.loads(EXTRACT.read_text(encoding="utf-8"))
        extracted = scoped_contract(producer, tracked)
        compare(tracked, extracted)
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(f"OpenAPI check failed: {exc}", file=sys.stderr)
        return 1
    operations = sum(len(item.keys() & HTTP_METHODS) for item in extracted["paths"].values())
    components = sum(map(len, extracted["components"].values()))
    print(f"Matched {operations} operations and {components} referenced components.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
