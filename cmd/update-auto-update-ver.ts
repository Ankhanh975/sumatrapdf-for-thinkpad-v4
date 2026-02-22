import { S3Client } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const ver = process.argv[2];
if (!ver) {
  console.error("usage: bun ./cmd/update-auto-update-ver.ts <version>");
  process.exit(1);
}

function validateVer(ver: string): void {
  const parts = ver.split(".");
  if (parts.length > 3) throw new Error(`invalid version: ${ver}`);
  for (let i = 0; i < parts.length; i++) {
    const n = parseInt(parts[i], 10);
    if (isNaN(n) || n < 0 || n > 19) throw new Error(`invalid version part: ${parts[i]}`);
    if (i === 0 && n !== 3) throw new Error("major version must be 3");
  }
}

function getSecrets(): { r2Access: string; r2Secret: string; b2Access: string; b2Secret: string } {
  const secretsPath = join("..", "secrets", "sumatrapdf.env");
  let m: Record<string, string> = {};
  try {
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      m[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
    }
  } catch {
    // fall through to env variables
  }
  return {
    r2Access: m["R2_ACCESS"] || process.env["R2_ACCESS"] || "",
    r2Secret: m["R2_SECRET"] || process.env["R2_SECRET"] || "",
    b2Access: m["BB_ACCESS"] || process.env["BB_ACCESS"] || "",
    b2Secret: m["BB_SECRET"] || process.env["BB_SECRET"] || "",
  };
}

validateVer(ver);

const content = `[SumatraPDF]\nLatest ${ver}\n`;
console.log(`Content of update file:\n${content}`);
const data = Buffer.from(content);

const secrets = getSecrets();
if (!secrets.r2Access || !secrets.r2Secret) throw new Error("R2_ACCESS/R2_SECRET not set");
if (!secrets.b2Access || !secrets.b2Secret) throw new Error("BB_ACCESS/BB_SECRET not set");

const remotePaths = ["sumatrapdf/sumpdf-update.txt", "sumatrapdf/sumpdf-latest.txt"];

// upload to Backblaze B2
const b2 = new S3Client({
  accessKeyId: secrets.b2Access,
  secretAccessKey: secrets.b2Secret,
  bucket: "kjk-files",
  endpoint: "https://s3.us-west-001.backblazeb2.com",
});
for (const remotePath of remotePaths) {
  await b2.write(remotePath, data);
  console.log(`uploaded to backblaze: ${remotePath}`);
}

// upload to Cloudflare R2
const r2 = new S3Client({
  accessKeyId: secrets.r2Access,
  secretAccessKey: secrets.r2Secret,
  bucket: "files",
  endpoint: "https://71694ef61795ecbe1bc331d217dbd7a7.r2.cloudflarestorage.com",
});
for (const remotePath of remotePaths) {
  await r2.write(remotePath, data);
  console.log(`uploaded to r2: ${remotePath}`);
}

// write local file
const path = join("website", "update-check-rel.txt");
writeFileSync(path, content, "utf-8");
console.log(`Don't forget to checkin file '${path}' and deploy website`);
