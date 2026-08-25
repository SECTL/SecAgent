import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [sourceArgument = "release/win-unpacked", outputArgument = "release/SecAgent.files.sha256"] = process.argv.slice(2);
const sourceDirectory = path.resolve(sourceArgument);
const outputFile = path.resolve(outputArgument);

if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
  throw new Error(`Packaged application directory does not exist: ${sourceDirectory}`);
}

const files = [];
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filePath);
    } else if (entry.isFile() && path.resolve(filePath) !== outputFile) {
      const relativePath = path.relative(sourceDirectory, filePath).split(path.sep).join("/");
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
      files.push(`${sha256}  ${relativePath}`);
    }
  }
};

visit(sourceDirectory);
files.sort((left, right) => left.slice(66).localeCompare(right.slice(66)));
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${files.join("\n")}\n`, "utf8");
console.log(`Wrote ${files.length} file hashes to ${outputFile}`);
