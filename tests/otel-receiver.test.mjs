// @ts-check
/** Unit tests for the OTLP-JSON metrics receiver. Run: node --test */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOtlpMetrics,
  OtelStore,
} from "../server/core/otel/receiver.mjs";

const m = (model) => ({ key: "model", value: { stringValue: model } });
const FIXTURE = {
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: "claude_code.cost.usage",
              sum: {
                dataPoints: [
                  {
                    asDouble: 0.05,
                    timeUnixNano: "1",
                    attributes: [m("opus")],
                  },
                  { asDouble: 0.2, attributes: [m("fable")] },
                ],
              },
            },
            {
              name: "claude_code.token.usage",
              sum: { dataPoints: [{ asInt: "1500", attributes: [m("opus")] }] },
            },
            {
              name: "claude_code.other",
              sum: { dataPoints: [{ asDouble: 99 }] },
            },
          ],
        },
      ],
    },
  ],
};

test("parseOtlpMetrics extracts only the cost/token data points", () => {
  const recs = parseOtlpMetrics(FIXTURE);
  assert.equal(recs.length, 3); // 2 cost + 1 token; 'other' ignored
  assert.equal(recs[0].value, 0.05);
  assert.equal(recs[0].attrs.model, "opus");
});

test("OtelStore accumulates cost + tokens by model", () => {
  const s = new OtelStore();
  const n = s.ingestMetrics(FIXTURE);
  assert.equal(n, 3);
  const sum = s.summary();
  assert.equal(sum.enabled, true);
  assert.equal(sum.totalCostUsd, 0.25);
  assert.equal(sum.byModel.opus.costUsd, 0.05);
  assert.equal(sum.byModel.opus.tokens, 1500);
  assert.equal(sum.byModel.fable.costUsd, 0.2);
});

test("empty / unexpected payloads are tolerated", () => {
  assert.deepEqual(parseOtlpMetrics({}), []);
  assert.deepEqual(parseOtlpMetrics(null), []);
  const s = new OtelStore();
  assert.equal(s.ingestMetrics({}), 0);
  assert.equal(s.summary().enabled, false);
});

test("cumulative baseline is monotonic: an out-of-order lower snapshot does not over-count", () => {
  const s = new OtelStore();
  const snap = (v) => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: 2, // cumulative running total
                  dataPoints: [{ asDouble: v, attributes: [m("fable")] }],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  s.ingestMetrics(snap(100));
  s.ingestMetrics(snap(80)); // out-of-order / lower snapshot
  s.ingestMetrics(snap(120));
  assert.equal(
    s.summary().totalCostUsd,
    120,
    "a regressing snapshot must not inflate the running total",
  );
});
