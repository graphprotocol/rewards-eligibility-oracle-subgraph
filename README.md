# Rewards Eligibility Oracle Subgraph

Indexes the per-indexer, per-day eligibility metrics that the
[rewards eligibility oracle](https://github.com/graphprotocol/rewards-eligibility-oracle) publishes on
Arbitrum One. Indexers can use it to see how much margin they have, why a day failed, and how a
criteria change affects them.

- [`docs/oracle-publishing.md`](docs/oracle-publishing.md): what the oracle publishes and when, and
  how each subgraph rule follows from it.
- [`docs/wire-format.md`](docs/wire-format.md): the payload encoding, field definitions and the test
  vector.

> The subgraph explains the eligibility verdict; it is not the verdict. The `RewardsEligibilityOracle`
> contract (`isEligible`, `getEligibilityRenewalTime`) remains the source of truth for eligibility.

## How it works

Each daily run, the oracle sends a binary payload as raw calldata to a dedicated `EventfulDataEdge`
contract, which emits it as `Log(bytes)`. The subgraph:

1. Ignores any event whose `transaction.from` is not the oracle's signing address. Anyone can call
   DataEdge.
2. Decodes the whole payload before writing anything. A malformed payload is logged and skipped,
   never aborted on, so it cannot fail the subgraph.
3. Applies it. Each published day is a full snapshot of that day, and the latest one in block order wins.
4. Recomputes every indexer's rolling aggregates over the latest run's 29-day window, against the
   latest criteria.

| | |
| --- | --- |
| Network | `arbitrum-one` |
| DataEdge | [`0xfECf1535294095d032e072552D03f10fF2bEEa76`](https://arbiscan.io/address/0xfECf1535294095d032e072552D03f10fF2bEEa76) |
| Start block | `509758967` |
| Oracle signing address | `0xF0a445E553BF9Bd3670fE66fc95c41FdEbbC094A` (in [`src/constants.ts`](src/constants.ts)) |
| Pruning | `never`, so the full entity history is kept and time-travel queries work |

If the oracle's key is rotated, `ORACLE_ADDRESS` in `src/constants.ts` must change with it, and the
subgraph must be redeployed.

## Entities

Days appear two ways: as an `Int` counting days since 1970-01-01 UTC (`dayNumber`, `runDay`,
`windowStartDay`, `windowEndDay`) and as a `YYYY-MM-DD` string. `Day`, `Run` and `IndexerDay` use the
date string in their ids.

| Entity | Id | What it is |
| --- | --- | --- |
| `IndexerDay` | `<indexer>-<YYYY-MM-DD>` | One indexer's counters for one day, the criteria they were published under, and `isFinal`. |
| `Indexer` | address | Rolling aggregates over the latest window: `onlineDays`, `daysWithAttempts`, `lastDayWithAttempts`. |
| `Day` | `YYYY-MM-DD` | A published day: which indexers are in its latest snapshot, `isFinal`, criteria. |
| `Run` | `YYYY-MM-DD` | One oracle run: window bounds, `indexersEvaluated`, `indexersEligible`, criteria, the days it carried. |
| `Criteria` | `minOnlineDays-minSubgraphs-maxLatencyMs-maxBlocksBehind` | A set of thresholds, and the first and last run that used them. |
| `Payload` | tx hash ++ log index | One accepted `Log` event. Immutable. |
| `OracleState` | `current` | The latest run, window and criteria, plus every indexer seen. |

All entities are kept forever. Nothing is deleted when it leaves the window.

## Reading the data correctly

- **An indexer missing from a day was routed nothing that day.** The oracle only publishes rows with
  `queryAttempts > 0`. If a later snapshot drops an indexer from a day, its `IndexerDay` is kept with
  every counter set to zero.
- **A day that was never published is not a zero day.** The oracle holds back days whose source data
  has not arrived, and only reaches back 7 days. Do not treat a missing `Day` as everyone offline.
- **Indexers routed nothing in the whole window never appear.** To list them, compare against your
  own indexer roster.
- **`isFinal: false` means a partial day.** A run at 10:00 UTC publishes its own day with about ten
  hours of data. The next run republishes it in full.
- **`IndexerDay.isOnlineDay` is as published.** It reflects the thresholds in that row's
  `criteria`. `Indexer.onlineDays` is recounted from `qualifyingQueries` and `qualifyingSubgraphs`
  against the latest criteria, so it stays exact when `MIN_SUBGRAPHS` changes. After a
  `MAX_LATENCY_MS` or `MAX_BLOCKS_BEHIND` change, older days stay approximate until they leave the
  window.
- **The `failed*` counters overlap.** One response can be both slow and behind chainhead. They
  are not parts of a whole, and they need not add up to `queryAttempts - qualifyingQueries`.
- **The window is 29 days, inclusive**: `[runDay - 28, runDay]`, not "the last 28 days".
- **Diagnosing a failed day.** If `queryAttempts` is 0, nothing was routed to the indexer. Otherwise
  look at the largest `failed*` counter. If all of them are 0 but the day still failed, the attempts
  had no recorded latency or chainhead data.

## Example queries

An indexer's standing in the current window:

```graphql
{
  oracleState(id: "current") {
    windowStartDay
    windowEndDay
    criteria { minOnlineDays minSubgraphs maxLatencyMs maxBlocksBehind }
    latestRun { date indexersEvaluated indexersEligible }
  }
  indexer(id: "0x...") {
    onlineDays
    daysWithAttempts
    lastDayWithAttempts { date }
  }
}
```

An indexer's daily breakdown for the window (use `windowStartDay` from above):

```graphql
{
  indexerDays(
    where: { indexer: "0x...", dayNumber_gte: 20703 }
    orderBy: dayNumber
    orderDirection: asc
  ) {
    date
    isFinal
    isOnlineDay
    queryAttempts
    qualifyingQueries
    qualifyingSubgraphs
    failedStatus
    failedLatency
    failedBlocksBehind
    criteria { id }
  }
}
```

## Development

Requires Node >= 20.18.1 and pnpm.

```sh
pnpm install
pnpm codegen   # generate types from schema.graphql and the ABI
pnpm build
pnpm test      # Matchstick unit tests
```

`.npmrc` hoists `assemblyscript`, because Matchstick looks for `node_modules/assemblyscript/bin/asc`
and pnpm does not put it there otherwise.

### Layout

```
abis/EventfulDataEdge.json   Log(bytes) event and fallback
schema.graphql               Entities
subgraph.yaml                Manifest
src/constants.ts             Oracle signing address
src/decoder.ts               Payload decoder; never aborts
src/mapping.ts               handleLog: applies payloads and recomputes aggregates
tests/decoder.test.ts        Decoder, including the test vector in docs/wire-format.md
tests/mapping.test.ts        Snapshot, restatement, duplicate, criteria-change and window rules
tests/mainnet.test.ts        The first real payload from Arbitrum One, checked against the Python decoder
tests/fixtures.ts            That payload and its expected values
tests/utils.ts               Payload builder and mock events
```

### Wire format

`src/decoder.ts` mirrors `decode_payload` in the oracle's `src/utils/data_edge_codec.py`, which is
the normative reference (see [`docs/wire-format.md`](docs/wire-format.md)). The decoder is stricter than the Python one. It also rejects:

- a duplicate `RunInfo` or `Criteria`
- a day repeated within one payload
- an `is_online_day` other than 0 or 1
- a day that does not fit in an `Int`
- a window that is inverted or wider than 366 days

The oracle's encoder produces none of these. A new wire-format version is refused until the decoder
is updated to support it.
