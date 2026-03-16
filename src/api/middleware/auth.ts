import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../../config/index.js";

export async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply) {
  const key = request.headers["x-api-key"] as string | undefined;
  if (!key || key !== config.crawlerApiKey) {
    reply.code(403).send({ error: "Forbidden", code: "INVALID_API_KEY" });
  }
}
