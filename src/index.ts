import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({
  ok: true,
  service: "solserver",
  ts: new Date().toISOString(),
}));

const port = Number(process.env.PORT ?? 3333);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});