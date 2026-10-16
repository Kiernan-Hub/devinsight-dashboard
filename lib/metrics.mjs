// Operational metrics for the ingest service, in Prometheus's text exposition format.
//
// A telemetry pipeline that cannot report on itself has a blind spot exactly where it matters:
// "are samples being dropped?" and "is ingest getting slower?" are questions about this service,
// not about the game. The Docker deployment serves these at GET /metrics (lib/node-server.mjs),
// where the optional monitoring profile in docker-compose.yml scrapes them into Prometheus and
// Grafana.
//
// On Vercel the same counters exist but are per-instance and never scraped — a serverless
// function has no long-lived process to scrape. They cost one Map lookup per update there.
//
// Hand-written rather than prom-client: the format is small, documented and stable, and the
// repository has no npm dependencies by design. lib/metrics.test.mjs checks the output, and CI
// validates the live endpoint with Prometheus's own `promtool check metrics`.

const escapeLabel = value => String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');

function labelString(names, values, extra = "") {
  const parts = names.map((name, i) => `${name}="${escapeLabel(values[i])}"`);
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(",")}}` : "";
}

// Small integers print as integers; everything else in full precision, which is what the format
// expects ("+Inf" aside).
const formatNumber = value => (value === Infinity ? "+Inf" : String(value));

export function createRegistry() {
  const families = new Map();

  function family(name, type, help, labelNames, extra = {}) {
    if (families.has(name)) {
      const existing = families.get(name);
      if (existing.type !== type) throw new Error(`metric ${name} already registered as a ${existing.type}`);
      return existing;
    }
    const created = { name, type, help, labelNames, series: new Map(), ...extra };
    families.set(name, created);
    return created;
  }

  // Label values are positional and must match labelNames. Keys join with a separator that cannot
  // appear in the escaped values.
  const keyOf = values => values.map(escapeLabel).join("\u0000");

  return {
    counter(name, help, labelNames = []) {
      const metric = family(name, "counter", help, labelNames);
      return {
        inc(labelValues = [], amount = 1) {
          if (!(amount >= 0)) throw new Error(`counter ${name} can only increase`);
          const key = keyOf(labelValues);
          const series = metric.series.get(key) ?? { labelValues, value: 0 };
          series.value += amount;
          metric.series.set(key, series);
        }
      };
    },

    gauge(name, help, labelNames = []) {
      const metric = family(name, "gauge", help, labelNames);
      return {
        set(labelValues = [], value) {
          metric.series.set(keyOf(labelValues), { labelValues, value });
        }
      };
    },

    histogram(name, help, labelNames = [], buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]) {
      const metric = family(name, "histogram", help, labelNames, { buckets: [...buckets].sort((a, b) => a - b) });
      return {
        observe(labelValues = [], value) {
          const key = keyOf(labelValues);
          const series = metric.series.get(key) ?? { labelValues, counts: metric.buckets.map(() => 0), sum: 0, count: 0 };
          metric.buckets.forEach((bound, i) => { if (value <= bound) series.counts[i] += 1; });
          series.sum += value;
          series.count += 1;
          metric.series.set(key, series);
        }
      };
    },

    // Called on every scrape, before rendering: for values read from the process rather than
    // counted as they happen (memory, uptime).
    collectors: [],

    render() {
      for (const collect of this.collectors) collect();
      const lines = [];
      for (const metric of families.values()) {
        lines.push(`# HELP ${metric.name} ${metric.help.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")}`);
        lines.push(`# TYPE ${metric.name} ${metric.type}`);
        for (const series of metric.series.values()) {
          if (metric.type === "histogram") {
            // Buckets are cumulative: observe() already counted each value into every bucket it
            // fits under.
            metric.buckets.forEach((bound, i) => {
              lines.push(`${metric.name}_bucket${labelString(metric.labelNames, series.labelValues, `le="${formatNumber(bound)}"`)} ${series.counts[i]}`);
            });
            lines.push(`${metric.name}_bucket${labelString(metric.labelNames, series.labelValues, 'le="+Inf"')} ${series.count}`);
            lines.push(`${metric.name}_sum${labelString(metric.labelNames, series.labelValues)} ${formatNumber(series.sum)}`);
            lines.push(`${metric.name}_count${labelString(metric.labelNames, series.labelValues)} ${series.count}`);
          } else {
            lines.push(`${metric.name}${labelString(metric.labelNames, series.labelValues)} ${formatNumber(series.value)}`);
          }
        }
      }
      return `${lines.join("\n")}\n`;
    }
  };
}

// The process-wide registry the ingest service reports into.
export const metrics = createRegistry();

export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
