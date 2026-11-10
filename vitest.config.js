import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";

export default defineWorkersConfig({
  test: {
    // Run by test:autoscale with its own credential-free, ephemeral D1 bindings.
    exclude: [...configDefaults.exclude, "src/db/jobs.autoscale.test.ts", "src/autoscale.test.ts", "src/middleware.cache.test.ts", "src/db/jobs.listing.test.ts", "src/utils/observability.test.ts", "src/utils/salad.observability.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});