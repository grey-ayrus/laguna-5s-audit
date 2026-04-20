#!/usr/bin/env node
// Throwaway helper: uploads the two cutting-section photos the user pointed to
// and prints the created audit's ID so we can open it in the browser for
// screenshotting. This avoids dealing with the hidden <input type="file"> in
// the MCP browser driver.
import { readFileSync } from "node:fs";

const IMAGE_PATHS = [
  "C:\\Users\\surymuth\\Downloads\\WhatsApp Image 2026-04-13 at 21.48.43.jpeg",
  "C:\\Users\\surymuth\\Downloads\\WhatsApp Image 2026-04-13 at 21.48.44.jpeg",
];

const images = IMAGE_PATHS.map((p) => {
  const buf = readFileSync(p);
  const b64 = buf.toString("base64");
  return `data:image/jpeg;base64,${b64}`;
});

const res = await fetch("http://127.0.0.1:5000/api/audits", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ zoneId: "zone-14", images }),
});

const body = await res.json();
if (!res.ok) {
  console.error("HTTP", res.status, body);
  process.exit(1);
}

console.log(JSON.stringify(body, null, 2).slice(0, 2000));
