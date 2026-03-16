import { createHmac } from "node:crypto";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";
import type { WebhookPayload } from "../shared/types.js";

class WebhookDispatcher {
  private sign(payload: string): string {
    return createHmac("sha256", config.webhookHmacSecret)
      .update(payload)
      .digest("hex");
  }

  async send(url: string, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const signature = this.sign(body);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Event": payload.event,
          "X-Webhook-Job-Id": payload.jobId,
          "User-Agent": "KadmooCrawler/1.0",
        },
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        logger.warn(
          { url, status: response.status, event: payload.event },
          "Webhook delivery failed (non-2xx)",
        );
      }
    } catch (err) {
      logger.warn({ err, url, event: payload.event }, "Webhook delivery error");
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
