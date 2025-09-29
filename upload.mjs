import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import mime from "mime-types";

dotenv.config();// ene connection success 

const DRY_RUN = String(process.env.DRY_RUN).toLowerCase() === "true";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 4;

function resolveEndpoint() {
  let endpoint = process.env.R2_ENDPOINT;
  const accountId = process.env.R2_ACCOUNT_ID;

  if (!endpoint && accountId) {
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  }
  if (!endpoint) {
    throw new Error(
      "Missing R2 endpoint. Set R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com or provide R2_ACCOUNT_ID."
    );
  }
  try {
    const u = new URL(endpoint);
    const host = u.hostname;
    const secret = process.env.R2_SECRET_ACCESS_KEY || "";
    const accessKey = process.env.R2_ACCESS_KEY_ID || "";
    // Common misconfig: using secret/access key in place of account ID
    // if (secret && host.startsWith(secret)) {
    //   throw new Error(
    //     "Invalid R2_ENDPOINT: it looks like your secret key is used as the subdomain. Use your Cloudflare ACCOUNT_ID."
    //   );
    // }
    if (accessKey && host.startsWith(accessKey)) {
      console.warn(
        "Warning: R2_ENDPOINT host appears to start with your access key id. It should start with your ACCOUNT_ID."
      );
    }
    return u.toString();
  } catch (e) {
    throw new Error(`Invalid R2_ENDPOINT URL: ${e.message}`);
  }
}

let clientSingleton = null;
function getClient() {
  if (clientSingleton) return clientSingleton;
  clientSingleton = new S3Client({
    region: "auto",
    endpoint: resolveEndpoint(),
    forcePathStyle: true, // avoids bucket-in-hostname DNS issues
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      sessionToken: process.env.R2_SESSION_TOKEN, // optional
    },
  });
  return clientSingleton;
}

function getContentType(filePath) {
  const guessed = mime.lookup(filePath) || "application/octet-stream";
  return guessed;
}

async function uploadFile(localPath, key) {
  if (DRY_RUN) {
    const publicUrl = `${process.env.R2_PUBLIC_URL || `https://${process.env.R2_BUCKET}.r2.dev`}/${key}`;
    console.log(`DRY ▶ ${localPath} → ${process.env.R2_BUCKET}/${key} (${getContentType(localPath)})`);
    console.log(`      Public URL: ${publicUrl}`);
    return;
  }
  const file = fs.readFileSync(localPath);
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: file,
    ContentType: getContentType(localPath),
  });
  await getClient().send(command);
  const publicUrl = `${process.env.R2_PUBLIC_URL || `https://${process.env.R2_BUCKET}.r2.dev`}/${key}`;
  console.log(`✅ Uploaded ${localPath} → ${process.env.R2_BUCKET}/${key}`);
  console.log(`   Public URL: ${publicUrl}`);
}

function walkFiles(rootDir) {
  /**
   * Recursively collect all file paths under rootDir, returning array of absolute paths
   */
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current);
      for (const entry of entries) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      out.push(current);
    }
  }
  return out;
}

async function run() {
  const imagesDir = path.resolve("./images");
  if (!fs.existsSync(imagesDir)) {
    console.error(`Images directory not found: ${imagesDir}`);
    process.exit(1);
  }

  const absFiles = walkFiles(imagesDir);
  if (absFiles.length === 0) {
    console.log("No files found to upload.");
    return;
  }

  // Preserve relative path under images/ when constructing S3 key
  const prefix = process.env.KEY_PREFIX || "uploads";
  const tasks = absFiles
    .sort()
    .slice(0, LIMIT ? Math.min(LIMIT, absFiles.length) : absFiles.length)
    .map((abs) => {
      const rel = path.relative(imagesDir, abs).replace(/\\/g, "/");
      const key = `${prefix}/${rel}`;
      return { abs, key };
    });

  console.log(`Found ${tasks.length} file(s). Concurrency=${CONCURRENCY}${DRY_RUN ? " (dry-run)" : ""}`);

  // Simple concurrency control
  let index = 0;
  const workers = new Array(Math.max(1, CONCURRENCY)).fill(0).map(async () => {
    while (index < tasks.length) {
      const i = index++;
      const { abs, key } = tasks[i];
      try {
        await uploadFile(abs, key);
      } catch (err) {
        console.error(`❌ Failed ${abs} → ${key}:`, err?.message || err);
      }
    }
  });
  await Promise.all(workers);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
