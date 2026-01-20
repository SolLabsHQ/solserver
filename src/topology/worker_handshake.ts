import { setTimeout as sleep } from "node:timers/promises";

type HandshakeLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

type TopologyKeyReader = {
  readTopologyKey: () => { topologyKey: string } | null;
};

type HandshakeOptions = {
  store: TopologyKeyReader;
  log: HandshakeLogger;
  apiBaseUrl: string;
  internalToken?: string;
  maxAttempts: number;
  retryDelayMs: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

type ApiTopologyResponse = {
  topologyKey?: string;
  createdAtMs?: number;
  createdBy?: string;
};

const buildTopologyUrl = (baseUrl: string) => new URL("/internal/topology", baseUrl).toString();

export async function runTopologyHandshake(opts: HandshakeOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;
  const url = buildTopologyUrl(opts.apiBaseUrl);
  const isFly = Boolean(process.env.FLY_APP_NAME);
  const isProd = process.env.NODE_ENV === "production" || isFly;

  if (!opts.internalToken && isProd) {
    opts.log.error(
      { evt: "topology.guard.worker_internal_token_missing_fatal" },
      "topology.guard.worker_internal_token_missing_fatal"
    );
    throw new Error("Topology guard: SOL_INTERNAL_TOKEN missing");
  }

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    const local = opts.store.readTopologyKey();

    if (!local) {
      if (attempt === opts.maxAttempts) {
        opts.log.error(
          { evt: "topology.guard.worker_key_missing_fatal", attempts: attempt },
          "topology.guard.worker_key_missing_fatal"
        );
        throw new Error("Topology guard: topology key missing");
      }

      opts.log.info(
        {
          evt: "topology.guard.worker_waiting_for_api_truth",
          attempt,
          maxAttempts: opts.maxAttempts,
          retryDelayMs: opts.retryDelayMs,
          reason: "key_missing",
        },
        "topology.guard.worker_waiting_for_api_truth"
      );
      await sleepImpl(opts.retryDelayMs);
      continue;
    }

    let response: Response;
    const headers = opts.internalToken
      ? { "x-sol-internal-token": opts.internalToken }
      : undefined;

    try {
      response = await fetchImpl(url, {
        headers,
      });
    } catch (error) {
      if (attempt === opts.maxAttempts) {
        opts.log.error(
          {
            evt: "topology.guard.worker_api_unreachable_fatal",
            attempts: attempt,
            error: String(error),
          },
          "topology.guard.worker_api_unreachable_fatal"
        );
        throw new Error("Topology guard: API unreachable");
      }

      opts.log.info(
        {
          evt: "topology.guard.worker_waiting_for_api_truth",
          attempt,
          maxAttempts: opts.maxAttempts,
          retryDelayMs: opts.retryDelayMs,
          reason: "api_unreachable",
          error: String(error),
        },
        "topology.guard.worker_waiting_for_api_truth"
      );
      await sleepImpl(opts.retryDelayMs);
      continue;
    }

    if (!response.ok) {
      if (attempt === opts.maxAttempts) {
        opts.log.error(
          {
            evt: "topology.guard.worker_api_unreachable_fatal",
            attempts: attempt,
            statusCode: response.status,
          },
          "topology.guard.worker_api_unreachable_fatal"
        );
        throw new Error(`Topology guard: API status ${response.status}`);
      }

      opts.log.info(
        {
          evt: "topology.guard.worker_waiting_for_api_truth",
          attempt,
          maxAttempts: opts.maxAttempts,
          retryDelayMs: opts.retryDelayMs,
          reason: "api_unreachable",
          statusCode: response.status,
        },
        "topology.guard.worker_waiting_for_api_truth"
      );
      await sleepImpl(opts.retryDelayMs);
      continue;
    }

    let payload: ApiTopologyResponse;
    try {
      payload = (await response.json()) as ApiTopologyResponse;
    } catch (error) {
      if (attempt === opts.maxAttempts) {
        opts.log.error(
          {
            evt: "topology.guard.worker_api_unreachable_fatal",
            attempts: attempt,
            error: String(error),
          },
          "topology.guard.worker_api_unreachable_fatal"
        );
        throw new Error("Topology guard: API response invalid");
      }

      opts.log.info(
        {
          evt: "topology.guard.worker_waiting_for_api_truth",
          attempt,
          maxAttempts: opts.maxAttempts,
          retryDelayMs: opts.retryDelayMs,
          reason: "api_unreachable",
          error: String(error),
        },
        "topology.guard.worker_waiting_for_api_truth"
      );
      await sleepImpl(opts.retryDelayMs);
      continue;
    }

    if (!payload.topologyKey) {
      if (attempt === opts.maxAttempts) {
        opts.log.error(
          { evt: "topology.guard.worker_key_missing_fatal", attempts: attempt },
          "topology.guard.worker_key_missing_fatal"
        );
        throw new Error("Topology guard: API topology key missing");
      }

      opts.log.info(
        {
          evt: "topology.guard.worker_waiting_for_api_truth",
          attempt,
          maxAttempts: opts.maxAttempts,
          retryDelayMs: opts.retryDelayMs,
          reason: "api_key_missing",
        },
        "topology.guard.worker_waiting_for_api_truth"
      );
      await sleepImpl(opts.retryDelayMs);
      continue;
    }

    if (payload.topologyKey !== local.topologyKey) {
      opts.log.error(
        {
          evt: "topology.guard.worker_key_mismatch_fatal",
        },
        "topology.guard.worker_key_mismatch_fatal"
      );
      throw new Error("Topology guard: topology key mismatch");
    }

    return;
  }
}
