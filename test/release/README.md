# Packed release validation

Install Node 24, Bun 1.3.10, and the locked development dependencies with `npm ci`. Install the browser engines with `npx playwright install --with-deps chrome webkit`.

Build with `npm run build`. This removes the previous `dist` directory, emits declarations, and bundles the paired ExifTool script and WASM. A failed Bun build stops the command.

After the release workflow has generated `exiftool-build.json`, run:

```sh
npm run test:release -- --expected-version 13.60 --source /path/to/verified/Image-ExifTool-13.60 --output artifacts/release-validation
```

Use an output directory with no existing `.tgz` files. The verifier packs once and extracts that exact tarball into a clean consumer. The resulting top-level tarball is the publication candidate; do not rebuild or repack after validation. JSON reports record artifact hashes, runtime versions, browser versions, and individual results. All required phases run even when the native comparison detects a metadata mismatch, and any failed phase exits nonzero.

The Node consumer imports the public package, build-info, and WASM asset exports. Node, Chrome, and Playwright WebKit check the exact `-ver` string, text and JSON output, config-first composite tags, golden byte-exact thumbnail extraction, binary-mode transform exclusion, base64 parity, and Unicode write/read without mutating the input bytes. JSON version numbers are compared numerically because ExifTool 13.60 may serialize as `13.6`.

Browser tests load the packaged module from a different URL directory than the page and module worker, with no custom fetch for the full suite. Separate fresh browser contexts check that custom fetch still receives the original relative asset string. They do not force garbage collection or replace module caches. Playwright WebKit is a useful engine gate; it does not establish parity with the actual Safari application.

Native comparison runs the same ExifTool release from the checksum-verified official source against 13 bundled upstream fixtures: JPEG (Canon and Nikon), DNG, TIFF, ICC, JPEG 2000, MP3, PDF, PNG, HEIC, QuickTime MOV, WebP, and XMP. Only the input path and host filesystem fields are excluded. Character-set metadata remains part of the comparison: `QuickTime.mov` must retain its MacRoman user-data fields. The report records the fixture hashes and every differing field. The suite is a release regression gate, not exhaustive format coverage.

These commands create local artifacts only; they do not publish packages or tags.
