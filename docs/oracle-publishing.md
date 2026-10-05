# How the oracle publishes

This describes what the oracle sends to DataEdge, and when. Each rule in
[`src/mapping.ts`](../src/mapping.ts) follows from it. The publishing code lives in
[rewards-eligibility-oracle](https://github.com/graphprotocol/rewards-eligibility-oracle)
(`publish_daily_metrics_to_data_edge` in `src/models/rewards_eligibility_oracle.py`).

## Why this exists

The oracle decides eligibility from 29 days of query data, but it only posts the **eligible
addresses** on chain. That leaves indexers with one bit of information:

- `isEligible` reads the same for an indexer with 22 qualifying days as for one with 5. The first is
  safe; the second is one bad day from lapsing.
- An ineligible indexer learns that it failed, not why. "No queries were routed to me" and "I served
  queries but every one was behind chainhead" have different fixes, and the contract shows both the
  same way.
- When a criterion changes (`MIN_SUBGRAPHS` goes from 1 to 5 on 2026-10-06), no indexer can tell
  whether it is affected.

So the oracle also publishes per-indexer, per-day metrics, and this subgraph makes them queryable.
That changes nothing about what decides eligibility. The `RewardsEligibilityOracle` contract remains
the source of truth.

## The analysis window

- A run for date `R` covers `[R - 28, R]`, **inclusive at both ends: 29 calendar days**.
- Days are UTC calendar days.
- The scheduled run fires at 10:00 UTC, so **day `R` is partial** and holds about ten hours of data.
  The next run republishes it in full.
- When the scheduler catches up a missed run, it runs it for yesterday (`R` = yesterday), so that run's
  final day is complete.

## What each run publishes

**Trailing days, not the whole window.** The subgraph keeps state, so each run sends only the last
`DATA_EDGE_PUBLISH_DAYS` (default 2) days of its window. With an overlap of two days, the next run
restates the partial day in full. The overlap also covers a day whose own run failed, and a day
whose source data arrived late.

**Reaching back over days not yet on chain.** A run whose publish fails still succeeds, so nothing
re-runs it. Each run checks which of the last 7 days have been confirmed on chain and widens its
selection back to the oldest one that has not. It never sends more than 7 days. Publishing was
switched on with a 7-day backfill: the first payload, at block 511942700, carried
2026-09-29 to 2026-10-04.

**Held-back days.** A selected day with no query attempts at all means its source data has not
arrived, so the oracle leaves it out rather than publishing zeros. The other days still go out. Days
in a payload therefore need not be consecutive. A day the oracle never manages to publish within its
7-day reach is never published.

**Duplicates.** Only a confirmed publish is recorded. A broadcast whose outcome is unknown is
retried by a later run. So the same days, and even the same run, can appear on chain more than
once.

**One sender.** Payloads are signed with the oracle's own key, the one holding the oracle role on
`RewardsEligibilityOracle`. They go to a dedicated DataEdge instance, in a separate transaction
from the renewals.

**Inline addresses.** Every row carries its full 20-byte address. There is no address registry,
because a registry kept by both the oracle and the subgraph could drift apart and silently decode
every later payload against the wrong addresses. A side effect is that nothing on chain lists the
indexers a run evaluated.

## How the subgraph follows from this

| Oracle behaviour | Subgraph rule |
| --- | --- |
| Days are republished by the overlap, catch-up and retries, each at least as fresh as the last copy | Last write wins, in block order |
| A `DailyMetrics` message lists every indexer with attempts that day | A republished day is a full snapshot. Indexers missing from it are zeroed, not left as they were |
| The same run can be published twice | `Payload` is keyed by tx hash and log index; `Run` by run date and overwritten |
| Day `R` is published at 10:00 UTC on day `R` | `isFinal` is false when a day is published on its own UTC date |
| Held-back days and days older than the 7-day reach never arrive | A missing day is not filled with zeros |
| A catch-up run for yesterday can land after today's run | It updates its days, but does not move the window or the criteria back |
| Only indexers with attempts are published | Indexers routed nothing for the whole window never appear |
| Only the trailing days are republished, so older days keep the criteria they were published under | Rolling aggregates are recounted from the counters against the latest criteria |

## Counter semantics

These hold for every payload.

1. **The `failed_*` counts overlap.** One response can be both slow and behind chainhead, and
   increments both. They are not parts of a whole.
2. **The `failed_*` counts do not explain every non-qualifying attempt.** An attempt with no
   recorded `response_time_ms` or `blocks_behind` breaches no bar, so it is counted in no `failed_*`
   column, yet it still does not qualify. So `query_attempts - qualifying_queries` can exceed every
   `failed_*` count, and all three can be zero on a day with no qualifying queries.
3. **`query_attempts = 0` means the gateway routed nothing**, which is a routing problem rather than
   a serving problem. On chain it is encoded by absence.
4. **`is_online_day` is a historical record** under the criteria of the run that produced it. To
   apply other thresholds, recount from `qualifying_queries` and `qualifying_subgraphs`. That is
   exact for `MIN_SUBGRAPHS` and `MIN_ONLINE_DAYS`, but impossible for `MAX_LATENCY_MS` and
   `MAX_BLOCKS_BEHIND`, because those decide what counts as qualifying in the first place.

## Indexers that never appear

The oracle's only source is query attempts, so it evaluates exactly the indexers that received at
least one attempt somewhere in the window. An indexer routed nothing across all 29 days appears in no
payload. Eligibility is unaffected, since such an indexer has no online days either way. But that
indexer has the most to learn from "nothing was routed to you". A consumer with its own indexer
roster (from the network subgraph, for example) can show it by noting which addresses are absent.
