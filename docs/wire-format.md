# Wire format

The payload the oracle sends to DataEdge, which this subgraph decodes in
[`src/decoder.ts`](../src/decoder.ts).

The normative reference is `src/utils/data_edge_codec.py` in
[rewards-eligibility-oracle](https://github.com/graphprotocol/rewards-eligibility-oracle). Its
`decode_payload` is what `src/decoder.ts` mirrors.

The oracle sends the payload as the raw calldata of a plain transaction to `EventfulDataEdge`. There is
no function selector and no ABI encoding. The contract's fallback emits `Log(bytes data)`, so `data` is
exactly the payload.

## Grammar

```
payload  := magic("RE" = 0x52 0x45) version(varint) message*
message  := tag(varint) body

0x01 RunInfo      := run_day, window_start_day, window_end_day,
                     indexers_evaluated, indexers_eligible
0x02 Criteria     := min_online_days, min_subgraphs, max_latency_ms, max_blocks_behind
0x03 DailyMetrics := day, row_count, row*
     row          := address(20 raw bytes), query_attempts, qualifying_queries, qualifying_subgraphs,
                     failed_status, failed_latency, failed_blocks_behind, is_online_day
```

- Every integer, tags included, is an **unsigned LEB128 varint** of at most 64 bits (at most 10
  bytes), so it decodes into a `u64`.
- Every day is **days since 1970-01-01** (UTC). For example, 2026-09-25 is 20721.
- The payload has no length prefix or terminator. Messages run to the end of the bytes.
- The current version is **1**. A decoder must refuse any other version and any unknown tag, rather
  than guess.

## Fields

| Field | Meaning |
| --- | --- |
| `run_day` | The date the oracle ran for |
| `window_start_day`, `window_end_day` | The analysis window, inclusive at both ends: `[run_day - 28, run_day]`, 29 days |
| `indexers_evaluated` | Indexers with at least one query attempt in the window |
| `indexers_eligible` | Indexers the run found eligible, whether or not every renewal batch then succeeded |
| `query_attempts` | All attempts routed to the indexer that day |
| `qualifying_queries` | Attempts meeting all three bars at once: `status = '200 OK'`, `response_time_ms < MAX_LATENCY_MS`, `blocks_behind < MAX_BLOCKS_BEHIND` |
| `qualifying_subgraphs` | Distinct deployments with at least one qualifying query that day |
| `failed_status` | Attempts where `status != '200 OK'` |
| `failed_latency` | Attempts where `response_time_ms >= MAX_LATENCY_MS` |
| `failed_blocks_behind` | Attempts where `blocks_behind >= MAX_BLOCKS_BEHIND` |
| `is_online_day` | 1 when `qualifying_queries >= 1 AND qualifying_subgraphs >= MIN_SUBGRAPHS`, under the criteria in the same payload |

An indexer is eligible when the number of online days in the window is at least `MIN_ONLINE_DAYS`.

## What the encoder guarantees in version 1

A decoder may rely on these, but should not need to. `src/decoder.ts` enforces the ones marked with *.

- Exactly one `RunInfo`* and exactly one `Criteria`*, then one or more `DailyMetrics`.
- `DailyMetrics` messages in ascending day order, each day at most once*, all within
  `[window_start_day, window_end_day]`. They are the trailing days of the window, but a held-back day
  leaves a gap.
- Within a day, rows are sorted by address, each address appears at most once, and only rows with
  `query_attempts > 0` are included. **An indexer absent from a published day was routed nothing
  that day.**
- `is_online_day` is 0 or 1*.

`src/decoder.ts` also refuses a day that does not fit in an `Int`, and a window that is inverted or
wider than 366 days.

## Properties to keep if the format is revised

- **Magic bytes.** DataEdge's fallback accepts calls from any address, so the magic is a cheap first
  filter. It is not authentication: the mapping checks `transaction.from` against the oracle address,
  because `Log(bytes)` does not carry a sender.
- **Criteria on every payload**, not only when they change. This costs about 6 bytes and makes each
  payload interpretable with no prior state: `is_online_day` means nothing without the thresholds
  that produced it.
- **An explicit version**, refused rather than guessed at when unrecognised. A deployed subgraph
  cannot fix data it has already indexed.

## Test vector

Produced by the oracle's `encode_payload` with two indexers over two days. The second indexer was
routed nothing on 2026-09-25, so it has no row there. 121 bytes, one hex string wrapped for width:

```
52450101f1a101d5a101f1a101bd018e010205018827d0860303f0a10102111111111111111111111111111111111111
1111f018c915066635c1020122222222222222222222222222222222222222221d000000021d0003f1a1010111111111
11111111111111111111111111111111b009cc08040a005a01
```

It decodes to:

```
version 1
RunInfo   run 2026-09-25 (20721), window 2026-08-28 (20693) .. 2026-09-25 (20721),
          evaluated 189, eligible 142
Criteria  MIN_ONLINE_DAYS 5, MIN_SUBGRAPHS 1, MAX_LATENCY_MS 5000, MAX_BLOCKS_BEHIND 50000
2026-09-24 (20720), 2 rows
  0x1111…1111  attempts 3184, qualifying 2761, subgraphs 6, failed status/latency/blocks 102/53/321, online 1
  0x2222…2222  attempts 29,   qualifying 0,    subgraphs 0, failed status/latency/blocks 0/2/29,     online 0
2026-09-25 (20721), 1 row
  0x1111…1111  attempts 1200, qualifying 1100, subgraphs 4, failed status/latency/blocks 10/0/90,    online 1
```

`tests/decoder.test.ts` asserts this decoding. `tests/mainnet.test.ts` checks the first real
payload from Arbitrum One against values computed by the Python decoder.

To decode a real transaction's payload with the reference implementation, from a checkout of the
oracle repository:

```python
from src.utils.data_edge_codec import decode_payload
decode_payload(bytes.fromhex("5245..."))
```
