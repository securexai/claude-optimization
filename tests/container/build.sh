#!/usr/bin/env bash
# build.sh: build the image that tests/container/run.sh runs (see tests/container/Containerfile).
#
# Idempotent: building again with the same inputs reuses the layer cache and retags the same images. It pulls the base
# image (official Fedora 45) only when it is not in local storage, and it never removes anything. The pull adds that
# base image to local storage, and the shfmt build stage is kept as localhost/claude-test:builder-shfmt (a multi-stage
# build would otherwise leave it untagged); `run.sh audit-diff` expects all three.
#
# Usage: tests/container/build.sh
# Environment overrides: BASE_IMAGE, CLAUDE_CODE_VERSION, IMAGE_TAG.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
base_image=${BASE_IMAGE:-registry.fedoraproject.org/fedora:45}
version=${CLAUDE_CODE_VERSION:-2.1.318}
tag=${IMAGE_TAG:-localhost/claude-test:fedora-45}
builder_tag=${tag%:*}:builder-shfmt

command -v podman >/dev/null 2>&1 || { echo "Error: podman not found in PATH." >&2; exit 1; }

if podman image exists "$base_image"; then
  echo "Base image $base_image is already in local storage; not pulling."
else
  echo "Base image $base_image is not in local storage; the build will pull it."
fi

# --unsetlabel only matters when BASE_IMAGE is a toolbox image: it keeps the test image out of `toolbox list`.
common=(--pull=missing --unsetlabel com.github.containers.toolbox
  --build-arg "BASE_IMAGE=$base_image" --build-arg "CLAUDE_CODE_VERSION=$version" -f "$here/Containerfile")

# The shfmt stage first, under its own name; the second build reuses its layers from the cache.
podman build "${common[@]}" --target shfmt-build -t "$builder_tag" "$here"
podman build "${common[@]}" -t "$tag" "$here"
echo "Built $tag: Claude Code $version on $base_image (shfmt build stage: $builder_tag)."
