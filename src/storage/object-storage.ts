import * as stream from "node:stream";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { gzipSync, gunzipSync, createGzip, createGunzip } from "node:zlib";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";

class ObjectStorage {
  private client: S3Client | null = null;

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        endpoint: config.s3.endpoint,
        region: config.s3.region,
        credentials: {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        },
        forcePathStyle: true,
      });
    }
    return this.client;
  }

  isEnabled(): boolean {
    return config.s3.enabled;
  }

  async uploadJson(key: string, data: unknown): Promise<string> {
    const json = JSON.stringify(data);
    const compressed = gzipSync(Buffer.from(json, "utf-8"));

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: compressed,
        ContentType: "application/json",
        ContentEncoding: "gzip",
      }),
    );

    logger.debug({ key, sizeBytes: compressed.length }, "Uploaded to S3");
    return key;
  }

  async downloadJson<T = unknown>(key: string): Promise<T> {
    const result = await this.getClient().send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
      }),
    );

    const bytes = await result.Body?.transformToByteArray();
    if (!bytes || bytes.length === 0) throw new Error(`Empty response for key: ${key}`);

    const decompressed = gunzipSync(Buffer.from(bytes));
    return JSON.parse(decompressed.toString("utf-8")) as T;
  }

  /**
   * Stream NDJSON file to S3 with metadata first line. Avoids "Invalid string length" for large crawls.
   * Format: gzip(metadataLine + "\n" + ndjsonContent)
   */
  async uploadNdjsonStream(
    ndjsonPath: string,
    key: string,
    metadata: { summary: unknown; config?: unknown; jobId?: string; status?: string },
  ): Promise<string> {
    const metaLine = JSON.stringify(metadata) + "\n";
    const combined = new stream.PassThrough();
    combined.write(metaLine);
    createReadStream(ndjsonPath).pipe(combined, { end: true });

    const gzipStream = combined.pipe(createGzip());

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: gzipStream as any,
        ContentType: "application/json",
        ContentEncoding: "gzip",
      }),
    );

    logger.debug({ key }, "Streamed NDJSON to S3");
    return key;
  }

  /**
   * Stream download and parse line-by-line. Avoids "Invalid string length" for large artifacts.
   * Supports: (1) new format = metadata line + NDJSON pages, (2) legacy = single JSON with pages.
   */
  async downloadNdjsonStream<T = unknown>(key: string): Promise<T> {
    const result = await this.getClient().send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
      }),
    );

    const body = result.Body;
    if (!body) throw new Error(`Empty response for key: ${key}`);

    let nodeStream: stream.Readable;
    const bodyAny = body as { pipe?: (dest: NodeJS.WritableStream) => void; getReader?: () => unknown };
    if (typeof bodyAny.pipe === "function") {
      nodeStream = body as stream.Readable;
    } else if (typeof bodyAny.getReader === "function") {
      nodeStream = stream.Readable.fromWeb(body as any);
    } else {
      const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      const decompressed = gunzipSync(Buffer.from(bytes));
      if (decompressed.length > 400_000_000) {
        throw new Error(`Artifact too large (${(decompressed.length / 1e6).toFixed(1)}MB) for buffer parse`);
      }
      return this.parseNdjsonFromBuffer(decompressed) as T;
    }

    const gunzipStream = nodeStream.pipe(createGunzip());
    const rl = createInterface({ input: gunzipStream, crlfDelay: Infinity });

    let firstLine = true;
    let metadata: Record<string, unknown> = {};
    const pages: unknown[] = [];

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (firstLine) {
        if (Array.isArray(parsed.pages)) return parsed as T;
        metadata = parsed;
        firstLine = false;
      } else {
        pages.push(parsed);
      }
    }

    return { ...metadata, pages } as T;
  }

  private parseNdjsonFromBuffer(buf: Buffer): unknown {
    const text = buf.toString("utf-8");
    const firstNewline = text.indexOf("\n");
    const firstLine = firstNewline >= 0 ? text.slice(0, firstNewline) : text;
    try {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      if (Array.isArray(parsed.pages)) return parsed;
      const pages: unknown[] = [];
      const rest = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
      for (const line of rest.split("\n")) {
        const t = line.trim();
        if (t) pages.push(JSON.parse(t));
      }
      return { ...parsed, pages };
    } catch {
      return JSON.parse(text) as unknown;
    }
  }

  /** List object keys under a prefix, sorted ascending (oldest first). */
  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await this.getClient().send(
        new ListObjectsV2Command({
          Bucket: config.s3.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of result.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys.sort();
  }
}

export const objectStorage = new ObjectStorage();
