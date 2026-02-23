#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import pathlib


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def classify(line: str) -> str:
    low = line.lower()
    if "|" in line or "\t" in line or "table" in low:
        return "table"
    if line.startswith("!["):
        return "figure"
    if line.startswith("```"):
        return "code"
    return "text"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="in_path", required=True)
    parser.add_argument("--out", dest="out_dir", required=True)
    parser.add_argument("--use_llm", dest="use_llm", default="0")
    args = parser.parse_args()

    in_path = pathlib.Path(args.in_path)
    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    source = in_path.read_text(encoding="utf-8")
    lines = [line.strip() for line in source.splitlines() if line.strip()]

    blocks = []
    chunks = []
    for index, line in enumerate(lines):
        block_type = classify(line)
        content_sha = sha256_text(line)
        block = {
            "id": f"b-{index:03d}",
            "page": index + 1,
            "type": block_type,
            "text": line,
            "bbox": [0, 0, 100, 20],
            "content_sha256": content_sha,
        }
        blocks.append(block)
        chunks.append(
            {
                "chunk_id": f"chunk-{index:03d}",
                "page": index + 1,
                "type": block_type,
                "text": line,
                "content_sha256": content_sha,
            }
        )

    marker_json = {
        "version": "marker-stub-1.0.0",
        "meta": {
            "engine": "marker-stub",
            "use_llm": 1 if str(args.use_llm) == "1" else 0,
            "line_count": len(lines),
        },
        "blocks": blocks,
    }

    markdown_lines = ["# Marker Output", ""]
    for block in blocks:
        markdown_lines.append(f"- [{block['type']}] {block['text']}")
    marker_md = "\n".join(markdown_lines).strip() + "\n"

    marker_html = (
        "<html><body><ul>"
        + "".join(
            f"<li data-type=\"{b['type']}\" data-id=\"{b['id']}\">{b['text']}</li>" for b in blocks
        )
        + "</ul></body></html>\n"
    )

    (out_dir / "marker.json").write_text(json.dumps(marker_json, indent=2) + "\n", encoding="utf-8")
    (out_dir / "chunks.json").write_text(json.dumps(chunks, indent=2) + "\n", encoding="utf-8")
    (out_dir / "marker.md").write_text(marker_md, encoding="utf-8")
    (out_dir / "marker.html").write_text(marker_html, encoding="utf-8")

    images_dir = out_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    image_payload = hashlib.sha256(source.encode("utf-8")).digest()[:32]
    (images_dir / "img-0001.bin").write_bytes(image_payload)

    summary = {
        "engine": "marker-stub",
        "version": "marker-stub-1.0.0",
        "use_llm": 1 if str(args.use_llm) == "1" else 0,
        "blocks": len(blocks),
        "images": len(list(images_dir.iterdir())),
    }
    print(json.dumps(summary, sort_keys=True))
    print("marker_stub: deterministic mode", file=os.sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
