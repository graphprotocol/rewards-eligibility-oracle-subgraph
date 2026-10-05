import { BigInt, Bytes, log } from "@graphprotocol/graph-ts"
import { Log } from "../generated/DataEdge/EventfulDataEdge"
import {
  Criteria,
  Day,
  Indexer,
  IndexerDay,
  OracleState,
  Payload,
  Run
} from "../generated/schema"
import { ORACLE_ADDRESS, SECONDS_PER_DAY, STATE_ID } from "./constants"
import {
  Criteria as DecodedCriteria,
  DailyMetrics,
  Payload as DecodedPayload,
  dayToDate,
  decodePayload
} from "./decoder"

export function handleLog(event: Log): void {
  let txHash = event.transaction.hash.toHexString()

  if (!event.transaction.from.equals(ORACLE_ADDRESS)) {
    log.info("Ignoring DataEdge payload from {} in tx {}", [
      event.transaction.from.toHexString(),
      txHash
    ])
    return
  }

  // Decode everything before touching the store, so a payload is applied completely or not at all
  let result = decodePayload(event.params.data)
  if (result.error !== null) {
    log.warning("Ignoring malformed DataEdge payload in tx {}: {}", [txHash, result.error!])
    return
  }

  applyPayload(result.payload!, event)
}

function applyPayload(decoded: DecodedPayload, event: Log): void {
  let runInfo = decoded.runInfo
  let runId = dayToDate(runInfo.runDay)
  let payloadId = event.transaction.hash.concatI32(event.logIndex.toI32())
  let criteria = upsertCriteria(decoded.criteria, runId)

  // The final day of a scheduled run is cut off at about 10:00 UTC; only days before the block's UTC
  // date are complete
  let blockDay = (event.block.timestamp.toI64() / SECONDS_PER_DAY) as i32

  let state = OracleState.load(STATE_ID)
  let isLatestRun = state === null || runInfo.runDay >= Run.load(state.latestRun)!.runDay
  if (state === null) {
    state = new OracleState(STATE_ID)
    state.indexers = []
    state.payloadCount = 0
  }

  let dayIds = new Array<string>()
  let indexers = state.indexers
  for (let i = 0; i < decoded.days.length; i++) {
    dayIds.push(applyDay(decoded.days[i], criteria.id, payloadId, blockDay, indexers))
  }

  let payload = new Payload(payloadId)
  payload.run = runId
  payload.days = dayIds
  payload.transactionHash = event.transaction.hash
  payload.blockNumber = event.block.number
  payload.blockTimestamp = event.block.timestamp
  payload.save()

  // The same run can be published more than once; the latest payload in block order wins
  let run = Run.load(runId)
  if (run === null) {
    run = new Run(runId)
    run.payloadCount = 0
  }
  run.runDay = runInfo.runDay
  run.date = runId
  run.windowStartDay = runInfo.windowStartDay
  run.windowEndDay = runInfo.windowEndDay
  run.indexersEvaluated = BigInt.fromU64(runInfo.indexersEvaluated)
  run.indexersEligible = BigInt.fromU64(runInfo.indexersEligible)
  run.criteria = criteria.id
  run.days = dayIds
  run.latestPayload = payloadId
  run.transactionHash = event.transaction.hash
  run.blockNumber = event.block.number
  run.blockTimestamp = event.block.timestamp
  run.payloadCount = run.payloadCount + 1
  run.save()

  // A catch-up run for an earlier date can land after a later run; it updates its days but must not
  // move the window or the criteria backwards
  if (isLatestRun) {
    state.latestRun = runId
    state.windowStartDay = runInfo.windowStartDay
    state.windowEndDay = runInfo.windowEndDay
    state.criteria = criteria.id
  }
  state.indexers = indexers
  state.payloadCount = state.payloadCount + 1
  state.lastPayload = payloadId
  state.save()

  updateRollingAggregates(state)
}

function upsertCriteria(decoded: DecodedCriteria, runId: string): Criteria {
  let id =
    decoded.minOnlineDays.toString() +
    "-" +
    decoded.minSubgraphs.toString() +
    "-" +
    decoded.maxLatencyMs.toString() +
    "-" +
    decoded.maxBlocksBehind.toString()

  let criteria = Criteria.load(id)
  if (criteria === null) {
    criteria = new Criteria(id)
    criteria.minOnlineDays = BigInt.fromU64(decoded.minOnlineDays)
    criteria.minSubgraphs = BigInt.fromU64(decoded.minSubgraphs)
    criteria.maxLatencyMs = BigInt.fromU64(decoded.maxLatencyMs)
    criteria.maxBlocksBehind = BigInt.fromU64(decoded.maxBlocksBehind)
    criteria.firstRun = runId
  }
  criteria.lastRun = runId
  criteria.save()
  return criteria
}

// Writes one day as a full snapshot: indexers stored for the day but absent from this message were
// routed nothing as of this run, so their rows are zeroed rather than left as they were. Returns the
// day's id. New indexers are appended to `indexers`.
function applyDay(
  metrics: DailyMetrics,
  criteriaId: string,
  payloadId: Bytes,
  blockDay: i32,
  indexers: Array<Bytes>
): string {
  let dayId = dayToDate(metrics.day)
  let isFinal = metrics.day < blockDay

  let day = Day.load(dayId)
  let previous = new Array<Bytes>()
  if (day === null) {
    day = new Day(dayId)
    day.dayNumber = metrics.day
    day.date = dayId
  } else {
    previous = day.indexers
  }

  let current = new Array<Bytes>()
  let present = new Set<string>()
  for (let i = 0; i < metrics.rows.length; i++) {
    let row = metrics.rows[i]
    let indexerId = row.indexer

    if (Indexer.load(indexerId) === null) {
      let indexer = new Indexer(indexerId)
      indexer.onlineDays = 0
      indexer.daysWithAttempts = 0
      indexer.firstSeenDay = dayId
      indexer.save()
      indexers.push(indexerId)
    }

    let indexerDay = loadOrCreateIndexerDay(indexerId, dayId, metrics.day)
    indexerDay.queryAttempts = BigInt.fromU64(row.queryAttempts)
    indexerDay.qualifyingQueries = BigInt.fromU64(row.qualifyingQueries)
    indexerDay.qualifyingSubgraphs = BigInt.fromU64(row.qualifyingSubgraphs)
    indexerDay.failedStatus = BigInt.fromU64(row.failedStatus)
    indexerDay.failedLatency = BigInt.fromU64(row.failedLatency)
    indexerDay.failedBlocksBehind = BigInt.fromU64(row.failedBlocksBehind)
    indexerDay.isOnlineDay = row.isOnlineDay
    indexerDay.criteria = criteriaId
    indexerDay.isFinal = isFinal
    indexerDay.payload = payloadId
    indexerDay.save()

    current.push(indexerId)
    present.add(indexerId.toHexString())
  }

  for (let i = 0; i < previous.length; i++) {
    if (present.has(previous[i].toHexString())) continue

    let indexerDay = loadOrCreateIndexerDay(previous[i], dayId, metrics.day)
    indexerDay.queryAttempts = BigInt.zero()
    indexerDay.qualifyingQueries = BigInt.zero()
    indexerDay.qualifyingSubgraphs = BigInt.zero()
    indexerDay.failedStatus = BigInt.zero()
    indexerDay.failedLatency = BigInt.zero()
    indexerDay.failedBlocksBehind = BigInt.zero()
    indexerDay.isOnlineDay = false
    indexerDay.criteria = criteriaId
    indexerDay.isFinal = isFinal
    indexerDay.payload = payloadId
    indexerDay.save()
  }

  day.indexers = current
  day.indexerCount = current.length
  day.isFinal = isFinal
  day.criteria = criteriaId
  day.payload = payloadId
  day.save()

  return dayId
}

function indexerDayId(indexer: Bytes, dayId: string): string {
  return indexer.toHexString() + "-" + dayId
}

function loadOrCreateIndexerDay(indexer: Bytes, dayId: string, dayNumber: i32): IndexerDay {
  let id = indexerDayId(indexer, dayId)
  let indexerDay = IndexerDay.load(id)
  if (indexerDay === null) {
    indexerDay = new IndexerDay(id)
    indexerDay.indexer = indexer
    indexerDay.day = dayId
    indexerDay.dayNumber = dayNumber
    indexerDay.date = dayId
  }
  return indexerDay
}

class Aggregate {
  onlineDays: i32 = 0
  daysWithAttempts: i32 = 0
  lastDayWithAttempts: i32 = -1
}

// Recomputes every indexer's rolling aggregates over the latest window, against the latest criteria.
// Online days are recounted from the counters rather than summed from the stored isOnlineDay, because
// older days keep the thresholds they were published under. This is exact for MIN_SUBGRAPHS; days
// published before a MAX_LATENCY_MS or MAX_BLOCKS_BEHIND change stay approximate until they leave
// the window.
function updateRollingAggregates(state: OracleState): void {
  let criteria = Criteria.load(state.criteria)!
  let minSubgraphs = criteria.minSubgraphs
  let one = BigInt.fromI32(1)

  let aggregates = new Map<string, Aggregate>()
  for (let dayNumber = state.windowStartDay; dayNumber <= state.windowEndDay; dayNumber++) {
    let dayId = dayToDate(dayNumber)
    let day = Day.load(dayId)
    if (day === null) continue

    let dayIndexers = day.indexers
    for (let i = 0; i < dayIndexers.length; i++) {
      let indexerDay = IndexerDay.load(indexerDayId(dayIndexers[i], dayId))
      if (indexerDay === null) continue

      let key = dayIndexers[i].toHexString()
      let aggregate: Aggregate
      if (aggregates.has(key)) {
        aggregate = aggregates.get(key)
      } else {
        aggregate = new Aggregate()
        aggregates.set(key, aggregate)
      }

      if (indexerDay.queryAttempts.gt(BigInt.zero())) {
        aggregate.daysWithAttempts += 1
        if (dayNumber > aggregate.lastDayWithAttempts) aggregate.lastDayWithAttempts = dayNumber
      }
      if (indexerDay.qualifyingQueries.ge(one) && indexerDay.qualifyingSubgraphs.ge(minSubgraphs)) {
        aggregate.onlineDays += 1
      }
    }
  }

  let indexers = state.indexers
  for (let i = 0; i < indexers.length; i++) {
    let indexer = Indexer.load(indexers[i])!
    let key = indexers[i].toHexString()

    if (aggregates.has(key)) {
      let aggregate = aggregates.get(key)
      indexer.onlineDays = aggregate.onlineDays
      indexer.daysWithAttempts = aggregate.daysWithAttempts
      indexer.lastDayWithAttempts =
        aggregate.lastDayWithAttempts >= 0 ? dayToDate(aggregate.lastDayWithAttempts) : null
    } else {
      indexer.onlineDays = 0
      indexer.daysWithAttempts = 0
      indexer.lastDayWithAttempts = null
    }
    indexer.save()
  }
}
