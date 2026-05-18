import fs from "fs";
import path from "path";

const rulesDir = path.join(process.cwd(), "open-sse", "services", "compression", "rules");

function findJsonFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...findJsonFiles(full));
    else if (e.isFile() && e.name.endsWith(".json")) files.push(full);
  }
  return files;
}

const files = findJsonFiles(rulesDir);
let ok = true;
for (const f of files) {
  try {
    const raw = fs.readFileSync(f, "utf8");
    JSON.parse(raw);
    console.log("OK   ", f);
  } catch (err) {
    ok = false;
    console.error("ERROR", f, err && err.message ? err.message : String(err));
  }
}
if (!ok) process.exitCode = 2;
