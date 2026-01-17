import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
let text = fs.readFileSync(pkgPath, "utf8");
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
const data = JSON.parse(text);
fs.writeFileSync(pkgPath, JSON.stringify(data, null, 2) + "\n", "utf8");

// CLI packaging helpers
