import Fastify from "fastify";
import cors from "@fastify/cors";

import { healthRoutes } from "./routes/healthz";
import { chatRoutes } from "./routes/chat";

const app = Fastify({ logger: true });

async function main() {
  // CORS (v0/dev): permissive. Tighten before prod.
  app.register(cors, {
    origin: true,
  });

  // Routes
  app.register(healthRoutes);
  app.register(chatRoutes, { prefix: "/v1" });

  const port = Number(process.env.PORT ?? 3333);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});