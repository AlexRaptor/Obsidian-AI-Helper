import fs from "fs";

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
manifest.version = version;
fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
