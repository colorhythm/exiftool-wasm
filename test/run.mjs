import assert from "node:assert";
import { parseMetadata } from "../dist/esm/index.js";

const png = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
), (c) => c.charCodeAt(0));

const r = await parseMetadata({ name: "test.png", data: png });
assert.strictEqual(r.success, true, "parseMetadata failed: " + (r.error || ""));
assert.match(String(r.data), /ExifTool Version Number/, "unexpected output");
console.log("PASS:", String(r.data).split("\n")[0].trim());
