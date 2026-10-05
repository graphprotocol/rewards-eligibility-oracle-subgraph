// Decoder for the eligibility metrics payload the oracle publishes to DataEdge.
//
// Mirrors decode_payload in rewards-eligibility-oracle's src/utils/data_edge_codec.py, which is the
// normative reference for the wire format:
//
//   payload  := magic("RE") version(varint) message*
//   message  := tag(varint) body
//
//   0x01 RunInfo      := run_day, window_start_day, window_end_day, indexers_evaluated, indexers_eligible
//   0x02 Criteria     := min_online_days, min_subgraphs, max_latency_ms, max_blocks_behind
//   0x03 DailyMetrics := day, row_count, row*
//        row          := address(20 bytes), query_attempts, qualifying_queries, qualifying_subgraphs,
//                        failed_status, failed_latency, failed_blocks_behind, is_online_day
//
// Every integer is an unsigned LEB128 varint of at most 64 bits; every day is days since 1970-01-01.
//
// Anyone can send anything to DataEdge, and an abort here would fail the subgraph for good. So nothing
// in this file aborts: every read is bounds-checked, and the first error is recorded and returned
// instead of a payload.

import { Bytes } from "@graphprotocol/graph-ts"

export const ENCODING_VERSION: u64 = 1

export const TAG_RUN_INFO: u64 = 0x01
export const TAG_CRITERIA: u64 = 0x02
export const TAG_DAILY_METRICS: u64 = 0x03

const MAGIC_0: u8 = 0x52 // "R"
const MAGIC_1: u8 = 0x45 // "E"

const ADDRESS_LENGTH: i32 = 20

// An address plus seven one-byte varints. A row count that could not fit in the remaining bytes is
// rejected before looping over it.
const MIN_ROW_LENGTH: i32 = ADDRESS_LENGTH + 7

// Days are stored as Int, so they must fit in an i32
const MAX_DAY: u64 = 2147483647

// The oracle's window is 29 days. Anything far wider is malformed, and is refused so that rolling
// aggregates never loop over an unbounded range.
export const MAX_WINDOW_DAYS: i32 = 366

export class RunInfo {
  constructor(
    public runDay: i32,
    public windowStartDay: i32,
    public windowEndDay: i32,
    public indexersEvaluated: u64,
    public indexersEligible: u64
  ) {}
}

export class Criteria {
  constructor(
    public minOnlineDays: u64,
    public minSubgraphs: u64,
    public maxLatencyMs: u64,
    public maxBlocksBehind: u64
  ) {}
}

export class Row {
  constructor(
    public indexer: Bytes,
    public queryAttempts: u64,
    public qualifyingQueries: u64,
    public qualifyingSubgraphs: u64,
    public failedStatus: u64,
    public failedLatency: u64,
    public failedBlocksBehind: u64,
    public isOnlineDay: bool
  ) {}
}

export class DailyMetrics {
  constructor(public day: i32, public rows: Array<Row>) {}
}

export class Payload {
  constructor(
    public runInfo: RunInfo,
    public criteria: Criteria,
    public days: Array<DailyMetrics>
  ) {}
}

export class DecodeResult {
  constructor(public payload: Payload | null, public error: string | null) {}
}

class Reader {
  data: Bytes
  offset: i32
  error: string | null

  constructor(data: Bytes, offset: i32) {
    this.data = data
    this.offset = offset
    this.error = null
  }

  failed(): bool {
    return this.error !== null
  }

  // Keeps the first error, since later ones are consequences of it
  fail(message: string): void {
    if (this.error === null) {
      this.error = message
    }
  }

  remaining(): i32 {
    return this.data.length - this.offset
  }

  varint(): u64 {
    if (this.failed()) return 0

    let value: u64 = 0
    for (let i: i32 = 0; i < 10; i++) {
      if (this.offset >= this.data.length) {
        this.fail("payload ended in the middle of a varint")
        return 0
      }

      let byte = this.data[this.offset] as u64
      this.offset++
      let bits = byte & 0x7f

      // The tenth byte holds bit 63 only
      if (i == 9 && bits > 1) {
        this.fail("varint does not fit in 64 bits")
        return 0
      }

      value |= bits << ((i * 7) as u64)
      if ((byte & 0x80) == 0) return value
    }

    this.fail("varint is longer than 64 bits")
    return 0
  }

  day(): i32 {
    let value = this.varint()
    if (value > MAX_DAY) {
      this.fail("day is out of range: " + value.toString())
      return 0
    }
    return value as i32
  }

  address(): Bytes {
    if (this.failed()) return new Bytes(0)

    if (this.remaining() < ADDRESS_LENGTH) {
      this.fail("payload ended in the middle of an indexer address")
      return new Bytes(0)
    }

    let address = Bytes.fromUint8Array(this.data.subarray(this.offset, this.offset + ADDRESS_LENGTH))
    this.offset += ADDRESS_LENGTH
    return address
  }
}

function failure(message: string): DecodeResult {
  return new DecodeResult(null, message)
}

export function decodePayload(data: Bytes): DecodeResult {
  if (data.length < 2 || data[0] != MAGIC_0 || data[1] != MAGIC_1) {
    return failure("payload does not carry the expected magic bytes")
  }

  let reader = new Reader(data, 2)
  let version = reader.varint()
  if (reader.failed()) return failure(reader.error!)
  if (version != ENCODING_VERSION) {
    return failure("unsupported encoding version: " + version.toString())
  }

  let runInfo: RunInfo | null = null
  let criteria: Criteria | null = null
  let days = new Array<DailyMetrics>()

  while (reader.remaining() > 0 && !reader.failed()) {
    let tag = reader.varint()
    if (reader.failed()) break

    if (tag == TAG_RUN_INFO) {
      if (runInfo !== null) return failure("payload carries more than one RunInfo")

      let runDay = reader.day()
      let windowStartDay = reader.day()
      let windowEndDay = reader.day()
      let indexersEvaluated = reader.varint()
      let indexersEligible = reader.varint()
      runInfo = new RunInfo(runDay, windowStartDay, windowEndDay, indexersEvaluated, indexersEligible)
    } else if (tag == TAG_CRITERIA) {
      if (criteria !== null) return failure("payload carries more than one Criteria")

      let minOnlineDays = reader.varint()
      let minSubgraphs = reader.varint()
      let maxLatencyMs = reader.varint()
      let maxBlocksBehind = reader.varint()
      criteria = new Criteria(minOnlineDays, minSubgraphs, maxLatencyMs, maxBlocksBehind)
    } else if (tag == TAG_DAILY_METRICS) {
      let day = reader.day()
      let rowCount = reader.varint()
      if (reader.failed()) break

      if (rowCount > ((reader.remaining() / MIN_ROW_LENGTH) as u64)) {
        return failure("row count runs past the end of the payload: " + rowCount.toString())
      }

      for (let i = 0; i < days.length; i++) {
        if (days[i].day == day) return failure("payload carries day " + day.toString() + " twice")
      }

      let rows = new Array<Row>()
      for (let i: i32 = 0; i < (rowCount as i32); i++) {
        let indexer = reader.address()
        let queryAttempts = reader.varint()
        let qualifyingQueries = reader.varint()
        let qualifyingSubgraphs = reader.varint()
        let failedStatus = reader.varint()
        let failedLatency = reader.varint()
        let failedBlocksBehind = reader.varint()
        let isOnlineDay = reader.varint()
        if (reader.failed()) break

        if (isOnlineDay > 1) {
          return failure("is_online_day is not 0 or 1: " + isOnlineDay.toString())
        }

        rows.push(
          new Row(
            indexer,
            queryAttempts,
            qualifyingQueries,
            qualifyingSubgraphs,
            failedStatus,
            failedLatency,
            failedBlocksBehind,
            isOnlineDay == 1
          )
        )
      }
      days.push(new DailyMetrics(day, rows))
    } else {
      return failure("unknown message tag: " + tag.toString())
    }
  }

  if (reader.failed()) return failure(reader.error!)
  if (runInfo === null) return failure("payload carries no RunInfo")
  if (criteria === null) return failure("payload carries no Criteria")

  let run = runInfo
  if (run.windowEndDay < run.windowStartDay) {
    return failure("window ends before it starts")
  }
  if (run.windowEndDay - run.windowStartDay >= MAX_WINDOW_DAYS) {
    return failure("window is wider than " + MAX_WINDOW_DAYS.toString() + " days")
  }

  return new DecodeResult(new Payload(run, criteria, days), null)
}

function pad(value: i64, width: i32): string {
  return value.toString().padStart(width, "0")
}

// Days since 1970-01-01 to "YYYY-MM-DD", using Howard Hinnant's civil_from_days
export function dayToDate(day: i32): string {
  let z: i64 = (day as i64) + 719468
  let era: i64 = (z >= 0 ? z : z - 146096) / 146097
  let doe: i64 = z - era * 146097
  let yoe: i64 = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy: i64 = doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp: i64 = (5 * doy + 2) / 153
  let d: i64 = doy - (153 * mp + 2) / 5 + 1
  let m: i64 = mp < 10 ? mp + 3 : mp - 9
  let y: i64 = yoe + era * 400 + (m <= 2 ? 1 : 0)
  return pad(y, 4) + "-" + pad(m, 2) + "-" + pad(d, 2)
}
