import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [metadataArgument, versionArgument, tagArgument, assetArgument] = process.argv.slice(2);
const metadataFile = path.resolve(metadataArgument || "updates.json");
const version = String(versionArgument || "").trim().replace(/^v/i, "");
const tag = String(tagArgument || `v${version}`).trim();
const assetFile = path.resolve(assetArgument || "");
const privateKey = process.env.SECAGENT_UPDATE_PRIVATE_KEY?.trim();

if (!privateKey) throw new Error("SECAGENT_UPDATE_PRIVATE_KEY is required to sign update metadata");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid release version: ${version}`);
if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
if (!fs.existsSync(assetFile) || !fs.statSync(assetFile).isFile()) throw new Error(`Release asset does not exist: ${assetFile}`);

const assetName = path.basename(assetFile);
const expectedAssetName = `SecAgent-Setup-${version}.exe`;
if (assetName !== expectedAssetName) throw new Error(`Unexpected release asset name: ${assetName}`);

let previous = {};
if (fs.existsSync(metadataFile)) {
  try { previous = JSON.parse(fs.readFileSync(metadataFile, "utf8")); }
  catch (error) { throw new Error(`Cannot read existing update metadata: ${error instanceof Error ? error.message : String(error)}`); }
}

const channel = version.includes("-") ? "preview" : "stable";
const assetBytes = fs.readFileSync(assetFile);
const sha256 = crypto.createHash("sha256").update(assetBytes).digest("hex");
const entry = {
  channel,
  version,
  tag,
  assetName,
  assetUrl: `https://github.com/SECTL/SecAgent/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`,
  htmlUrl: `https://github.com/SECTL/SecAgent/releases/tag/${encodeURIComponent(tag)}`,
  sha256,
  size: assetBytes.length,
  publishedAt: new Date().toISOString()
};

const unsigned = {
  schemaVersion: 1,
  product: "SecAgent",
  generatedAt: new Date().toISOString(),
  channels: {
    ...(previous && typeof previous.channels === "object" && !Array.isArray(previous.channels) ? previous.channels : {}),
    [channel]: entry
  }
};
const signature = crypto.sign(null, Buffer.from(canonicalize(unsigned), "utf8"), privateKey).toString("base64");
const result = { ...unsigned, signature };
fs.mkdirSync(path.dirname(metadataFile), { recursive: true });
fs.writeFileSync(metadataFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`Wrote signed ${channel} update metadata for ${version} to ${metadataFile}`);

function canonicalize(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot canonicalize undefined value");
  return serialized;
}
