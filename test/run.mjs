import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { parseMetadata } from "../dist/esm/index.js";

// ── Test 1: text mode (default) still works ─────────────────────────
const png = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
), (c) => c.charCodeAt(0));

const r = await parseMetadata({ name: "test.png", data: png });
assert.strictEqual(r.success, true, "parseMetadata failed: " + (r.error || ""));
assert.match(String(r.data), /ExifTool Version Number/, "unexpected output");
console.log("PASS text:", String(r.data).split("\n")[0].trim());

// ── Test 2: binary mode (-b) is byte-exact ──────────────────────────
// Fixture: thumb_embedded.jpg carries thumb_groundtruth.jpg as its
// EXIF ThumbnailImage. Extract it three ways and demand byte equality:
//   (a) binary:true raw -b        — the new path under test
//   (b) -json -b base64           — ExifTool's text-safe binary mode
//   (c) the ground-truth file     — the bytes that were embedded
const fixture = new Uint8Array(
  await readFile(new URL("./data/thumb_embedded.jpg", import.meta.url)),
);
const groundTruth = new Uint8Array(
  await readFile(new URL("./data/thumb_groundtruth.jpg", import.meta.url)),
);

const bin = await parseMetadata(
  { name: "thumb_embedded.jpg", data: fixture },
  { args: ["-b", "-ThumbnailImage", "-m", "-q"], binary: true },
);
assert.strictEqual(bin.success, true, "binary extract failed: " + (bin.error || ""));
assert.ok(bin.data instanceof Uint8Array, "binary mode must return Uint8Array");
assert.strictEqual(bin.data.byteLength, groundTruth.byteLength,
  `binary length mismatch: ${bin.data.byteLength} vs ${groundTruth.byteLength}`);
assert.deepStrictEqual(bin.data, groundTruth, "binary bytes differ from ground truth");
console.log(`PASS binary: -b ThumbnailImage byte-exact (${bin.data.byteLength} bytes)`);

// ── Test 3: -config loads user-defined tags ─────────────────────────
// ExifTool honors -config ONLY as the first argument; the wrapper used
// to append it after the caller's args, where it was silently ignored
// and every user-defined tag came back unknown. A trivial composite
// proves the config actually loads.
const CONFIG_PROOF = `%Image::ExifTool::UserDefined = (
    'Image::ExifTool::Composite' => {
        ConfigProof => {
            Require => 'ImageWidth',
            ValueConv => '$val * 2',
        },
    },
);
1;
`;
const cfg = await parseMetadata(
  { name: "thumb_embedded.jpg", data: fixture },
  {
    args: ["-json", "-ImageWidth", "-ConfigProof", "-m", "-q"],
    config: { data: new TextEncoder().encode(CONFIG_PROOF), name: "proof.config" },
  },
);
assert.strictEqual(cfg.success, true, "config run failed: " + (cfg.error || ""));
const cfgRow = JSON.parse(String(cfg.data))[0];
assert.ok(cfgRow.ImageWidth > 0, "fixture has no width?");
assert.strictEqual(cfgRow.ConfigProof, cfgRow.ImageWidth * 2,
  "user-defined composite did not evaluate — -config not honored");
console.log(`PASS config: user-defined composite loaded (ConfigProof=${cfgRow.ConfigProof})`);

const b64 = await parseMetadata(
  { name: "thumb_embedded.jpg", data: fixture },
  { args: ["-json", "-b", "-ThumbnailImage", "-m", "-q"] },
);
assert.strictEqual(b64.success, true, "json/base64 extract failed: " + (b64.error || ""));
const payload = JSON.parse(String(b64.data))[0].ThumbnailImage;
assert.match(payload, /^base64:/, "expected base64: payload in -json -b mode");
const b64bytes = Uint8Array.from(atob(payload.slice(7)), (c) => c.charCodeAt(0));
assert.deepStrictEqual(b64bytes, groundTruth, "base64-decoded bytes differ from ground truth");
assert.deepStrictEqual(bin.data, b64bytes, "binary mode and base64 mode disagree");
console.log("PASS parity: binary mode == -json base64 mode == ground truth");
