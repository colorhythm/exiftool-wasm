# Release operations

The `publish.yml` workflow owns ExifTool releases. The old zeroperl updater is a
manual dispatcher and no longer updates sibling repositories independently.
Publishing `@colorhythm/zeroperl-ts` is not required: exiftool-wasm vendors its
adapter and consumes the CLI and WASM from one pinned zeroperl build.

## Gates

1. Read the official ExifTool version and source checksum, resolve the upstream
   Git tag, and inspect the actual latest npm tarball. Never use a Dockerfile pin
   to decide whether publication completed.
2. Build the pinned runtime with that checksum. The native ExifTool suite runs
   before installation. Required artifacts and character-set modules must remain
   available.
3. Run the standalone zeroperl-ts tests at the recorded revision with the new
   WASM. Explicitly skipped tests do not count as passing coverage.
4. Build with locked package dependencies and record source/output provenance.
5. Pack once and validate that package in Node, Chrome, and Playwright WebKit,
   including Window and module Worker contexts. Compare the selected official
   fixtures to the matching native ExifTool source. Filesystem metadata is
   excluded; warnings and metadata fields are not silently dropped.
6. After every gate passes, preserve the source commit, publish the exact tested
   tarball, verify the registry's tarball integrity and packaged-file hashes,
   and create the version tag.

Validation runs without npm credentials or repository write permission. Only the
publication job receives these permissions. It does not reinstall dependencies
or rerun package lifecycle scripts. Concurrency serializes release attempts, and
publication requires the source branch still to match the validated base.

## Activation and manual runs

Set `EXIFTOOL_AUTO_PUBLISH=true` as a repository Actions variable after the first
full candidate succeeds. Publication only runs from `main`. The `publish` input
can disable publication for a rehearsal, including a run from a repair branch:

```bash
gh workflow run publish.yml --repo colorhythm/exiftool-wasm \
    --ref main -f publish=false
```

The existing `NPM_TOKEN` secret is used for publication. Prefer npm trusted
publishing bound to this repository and `publish.yml` when configured for this
package; do not assume a stored token remains valid merely because it exists.
A missing or expired credential fails publication without marking the release
complete. Never log tokens or copy them into build artifacts.

## Retry and recovery

Rerun the workflow after fixing the failed gate or credential. A source commit
with an unpublished candidate version is pending work; the planner reuses that
version for the same upstream release. npm publication is immutable. If npm
accepted a tarball but receipt verification or tag creation failed, the next run
checks the published tarball against the committed manifest before recovering
the tag. A conflicting version or mismatched artifact fails closed.

An intervening main-branch change makes publication stop before its source push.
Rerun from the new main revision. Do not force-push the candidate over unrelated
work. Revert adapter changes through a normal reviewed commit and produce a new
package version; do not overwrite published versions.

## Scheduling and remaining limits

GitHub may delay scheduled jobs. Public-repository schedules also become
disabled after 60 days without repository activity. An hourly public schedule
therefore is not a durable unattended release monitor for infrequent upstream
releases. A private controller or external scheduler should dispatch this
workflow for long-term operation. Manual dispatch remains available. The
pipeline does not create artificial keepalive commits.

The package gates cover selected fixtures, not every ExifTool format. They do
not establish actual Safari compatibility or support for files over 2 GB. The
standalone wrapper suite still contains explicitly skipped tests. Firefox is
not part of supported-browser CI. Archive checksums pin ExifTool source; the
Docker base image and some toolchain downloads remain separate reproducibility
limitations.
