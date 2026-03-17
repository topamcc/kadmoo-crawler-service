import { createHmac } from "node:crypto";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import type { WebhookPayload } from "../shared/types.js";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class WebhookDispatcher {
  private sign(payload: string): string {
    return createHmac("sha256", config.webhookHmacSecret)
      .update(payload)
      .digest("hex");
  }

  async send(url: string, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const signature = this.sign(body);
    const headers = {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature,
      "X-Webhook-Event": payload.event,
      "X-Webhook-Job-Id": payload.jobId,
      "User-Agent": "KadmooCrawler/1.0",
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(15000),
        });

        if (response.ok) return;

        const retryable = response.status >= 500 || response.status === 429;
        if (!retryable || attempt === MAX_RETRIES) {
          logger.warn(
            { url, status: response.status, event: payload.event, attempt },
            "Webhook delivery failed (non-2xx)",
          );
          return;
        }
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          logger.warn({ err, url, event: payload.event, attempt }, "Webhook delivery error (all retries exhausted)");
          return;
        }
      }

      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
    }
  }

  static verifySignature(body: string, signature: string): boolean {
    const expected = createHmac("sha256", config.webhookHmacSecret)
      .update(body)
      .digest("hex");
    return signature === expected;
  }
}

export const webhookDispatcher = new WebhookDispatcher();
