import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { gzipSync, gunzipSync } from "node:zlib";
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
