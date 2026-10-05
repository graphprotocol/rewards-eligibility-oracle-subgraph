import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index"
import { Address, Bytes } from "@graphprotocol/graph-ts"
import { Day, Indexer, OracleState, Run } from "../generated/schema"
import { handleLog } from "../src/mapping"
import { STATE_ID } from "../src/constants"
import { DAY_24, DAY_25, INDEXER_1, INDEXER_2, PayloadBuilder, RowSpec, TEST_VECTOR, createLogEvent } from "./utils"

const ID_1_24 = INDEXER_1 + "-2026-09-24"
const ID_1_25 = INDEXER_1 + "-2026-09-25"
const ID_2_24 = INDEXER_2 + "-2026-09-24"
const ID_2_25 = INDEXER_2 + "-2026-09-25"

function online(indexer: string, subgraphs: u64): RowSpec {
  return new RowSpec(indexer, 100, 90, subgraphs, 1)
}

function publish(data: Bytes, blockDay: i32): void {
  handleLog(createLogEvent(data, blockDay))
}

describe("handleLog: filtering", () => {
  beforeEach(() => {
    clearStore()
  })

  test("ignores payloads not sent by the oracle", () => {
    let stranger = Address.fromString("0x000000000000000000000000000000000000dEaD")
    handleLog(createLogEvent(Bytes.fromHexString(TEST_VECTOR), DAY_25, stranger))
    assert.entityCount("Payload", 0)
    assert.entityCount("Run", 0)
    assert.entityCount("IndexerDay", 0)
  })

  test("writes nothing for a malformed payload from the oracle", () => {
    // The test vector with its last byte cut off
    let truncated = TEST_VECTOR.slice(0, TEST_VECTOR.length - 2)
    publish(Bytes.fromHexString(truncated), DAY_25)
    assert.entityCount("Payload", 0)
    assert.entityCount("Run", 0)
    assert.entityCount("Criteria", 0)
    assert.entityCount("Day", 0)
    assert.entityCount("IndexerDay", 0)
    assert.entityCount("Indexer", 0)
    assert.entityCount("OracleState", 0)
  })
})

describe("handleLog: test vector", () => {
  beforeEach(() => {
    clearStore()
    publish(Bytes.fromHexString(TEST_VECTOR), DAY_25)
  })

  test("stores the run, criteria and payload", () => {
    assert.entityCount("Payload", 1)
    assert.fieldEquals("Run", "2026-09-25", "runDay", "20721")
    assert.fieldEquals("Run", "2026-09-25", "windowStartDay", "20693")
    assert.fieldEquals("Run", "2026-09-25", "windowEndDay", "20721")
    assert.fieldEquals("Run", "2026-09-25", "indexersEvaluated", "189")
    assert.fieldEquals("Run", "2026-09-25", "indexersEligible", "142")
    assert.fieldEquals("Run", "2026-09-25", "criteria", "5-1-5000-50000")
    assert.fieldEquals("Run", "2026-09-25", "payloadCount", "1")
    assert.fieldEquals("Criteria", "5-1-5000-50000", "minSubgraphs", "1")
    assert.fieldEquals("Criteria", "5-1-5000-50000", "firstRun", "2026-09-25")
    assert.fieldEquals("OracleState", STATE_ID, "latestRun", "2026-09-25")
  })

  test("stores one IndexerDay per published row, with no row for an indexer routed nothing", () => {
    assert.entityCount("Day", 2)
    assert.entityCount("IndexerDay", 3)
    assert.notInStore("IndexerDay", ID_2_25)

    assert.fieldEquals("IndexerDay", ID_1_24, "queryAttempts", "3184")
    assert.fieldEquals("IndexerDay", ID_1_24, "qualifyingQueries", "2761")
    assert.fieldEquals("IndexerDay", ID_1_24, "qualifyingSubgraphs", "6")
    assert.fieldEquals("IndexerDay", ID_1_24, "failedStatus", "102")
    assert.fieldEquals("IndexerDay", ID_1_24, "failedLatency", "53")
    assert.fieldEquals("IndexerDay", ID_1_24, "failedBlocksBehind", "321")
    assert.fieldEquals("IndexerDay", ID_1_24, "isOnlineDay", "true")
    assert.fieldEquals("IndexerDay", ID_1_24, "criteria", "5-1-5000-50000")
    assert.fieldEquals("IndexerDay", ID_2_24, "isOnlineDay", "false")
    assert.fieldEquals("IndexerDay", ID_1_25, "queryAttempts", "1200")
  })

  test("marks the run's own day as provisional when published that same day", () => {
    assert.fieldEquals("Day", "2026-09-24", "isFinal", "true")
    assert.fieldEquals("Day", "2026-09-25", "isFinal", "false")
    assert.fieldEquals("IndexerDay", ID_1_25, "isFinal", "false")
  })

  test("computes rolling aggregates over the window", () => {
    assert.fieldEquals("Indexer", INDEXER_1, "onlineDays", "2")
    assert.fieldEquals("Indexer", INDEXER_1, "daysWithAttempts", "2")
    assert.fieldEquals("Indexer", INDEXER_1, "lastDayWithAttempts", "2026-09-25")
    assert.fieldEquals("Indexer", INDEXER_1, "firstSeenDay", "2026-09-24")
    assert.fieldEquals("Indexer", INDEXER_2, "onlineDays", "0")
    assert.fieldEquals("Indexer", INDEXER_2, "daysWithAttempts", "1")
    assert.fieldEquals("Indexer", INDEXER_2, "lastDayWithAttempts", "2026-09-24")
  })
})

describe("handleLog: restatement", () => {
  beforeEach(() => {
    clearStore()
  })

  test("zeroes an indexer missing from a republished day", () => {
    publish(Bytes.fromHexString(TEST_VECTOR), DAY_25)

    // Next run republishes 2026-09-25 without indexer 1 and with indexer 2
    let restated = PayloadBuilder.run(DAY_25 + 1, 1)
      .day(DAY_25, [online(INDEXER_2, 3)])
      .day(DAY_25 + 1, [online(INDEXER_2, 3)])
      .build()
    publish(restated, DAY_25 + 1)

    assert.fieldEquals("IndexerDay", ID_1_25, "queryAttempts", "0")
    assert.fieldEquals("IndexerDay", ID_1_25, "qualifyingQueries", "0")
    assert.fieldEquals("IndexerDay", ID_1_25, "isOnlineDay", "false")
    assert.fieldEquals("IndexerDay", ID_2_25, "queryAttempts", "100")

    let day = Day.load("2026-09-25")!
    assert.i32Equals(1, day.indexers.length)
    assert.bytesEquals(Bytes.fromHexString(INDEXER_2), day.indexers[0])
    assert.fieldEquals("Day", "2026-09-25", "isFinal", "true")
    assert.fieldEquals("IndexerDay", ID_2_25, "isFinal", "true")

    // Indexer 1 keeps only 2026-09-24
    assert.fieldEquals("Indexer", INDEXER_1, "onlineDays", "1")
    assert.fieldEquals("Indexer", INDEXER_1, "lastDayWithAttempts", "2026-09-24")
    assert.fieldEquals("Indexer", INDEXER_2, "onlineDays", "2")
  })

  test("applies the same payload twice without changing the result", () => {
    publish(Bytes.fromHexString(TEST_VECTOR), DAY_25)
    publish(Bytes.fromHexString(TEST_VECTOR), DAY_25)

    assert.entityCount("Payload", 2)
    assert.entityCount("Run", 1)
    assert.entityCount("IndexerDay", 3)
    assert.fieldEquals("Run", "2026-09-25", "payloadCount", "2")
    assert.fieldEquals("IndexerDay", ID_1_24, "queryAttempts", "3184")
    assert.fieldEquals("Indexer", INDEXER_1, "onlineDays", "2")
  })
})

describe("handleLog: window and criteria", () => {
  beforeEach(() => {
    clearStore()
  })

  test("recounts older days against a new MIN_SUBGRAPHS", () => {
    publish(PayloadBuilder.run(DAY_24, 1).day(DAY_24, [online(INDEXER_1, 3)]).build(), DAY_24)
    assert.fieldEquals("Indexer", INDEXER_1, "onlineDays", "1")

    // MIN_SUBGRAPHS goes to 5; 2026-09-24 had 3 qualifying subgraphs and is no longer an online day
    publish(PayloadBuilder.run(DAY_25, 5).day(DAY_25, [online(INDEXER_1, 6)]).build(), DAY_25)

    assert.fieldEquals("OracleState", STATE_ID, "criteria", "5-5-5000-50000")
    assert.fieldEquals("Indexer", INDEXER_1, "onlineDays", "1")
    assert.fieldEquals("Indexer", INDEXER_1, "daysWithAttempts", "2")
    // The stored flag keeps the thresholds it was published under
    assert.fieldEquals("IndexerDay", ID_1_24, "isOnlineDay", "true")
    assert.fieldEquals("IndexerDay", ID_1_24, "criteria", "5-1-5000-50000")
    assert.fieldEquals("Criteria", "5-1-5000-50000", "lastRun", "2026-09-24")
    assert.fieldEquals("Criteria", "5-5-5000-50000", "firstRun", "2026-09-25")
  })

  test("drops days that leave the window from the aggregates, but keeps them stored", () => {
    publish(PayloadBuilder.run(DAY_24, 1).day(DAY_24, [online(INDEXER_1, 1)]).build(), DAY_24)

    // 29 days later, 2026-09-24 is outside [run - 28, run]
    let later = DAY_24 + 29
    publish(PayloadBuilder.run(later, 1).day(later, [online(INDEXER_2, 1)]).build(), later)

    assert.fieldEquals("Indexer", INDEXER_1, "onlineDays", "0")
    assert.fieldEquals("Indexer", INDEXER_1, "daysWithAttempts", "0")
    assert.fieldEquals("Indexer", INDEXER_1, "lastDayWithAttempts", "null")
    assert.fieldEquals("Indexer", INDEXER_2, "onlineDays", "1")
    assert.fieldEquals("IndexerDay", ID_1_24, "queryAttempts", "100")
  })

  test("a catch-up run for an earlier date does not move the window back", () => {
    publish(PayloadBuilder.run(DAY_25, 5).day(DAY_25, [online(INDEXER_1, 6)]).build(), DAY_25)
    // Catch-up for yesterday lands later, under older criteria
    publish(PayloadBuilder.run(DAY_24, 1).day(DAY_24, [online(INDEXER_1, 3)]).build(), DAY_25)

    assert.fieldEquals("OracleState", STATE_ID, "latestRun", "2026-09-25")
    assert.fieldEquals("OracleState", STATE_ID, "windowEndDay", "20721")
    assert.fieldEquals("OracleState", STATE_ID, "criteria", "5-5-5000-50000")
    assert.fieldEquals("OracleState", STATE_ID, "payloadCount", "2")
    // The caught-up day is stored, final, and counted against the latest criteria
    assert.fieldEquals("Day", "2026-09-24", "isFinal", "true")
    assert.fieldEquals("Indexer", INDEXER_1, "daysWithAttempts", "2")
    assert.fieldEquals("Indexer", INDEXER_1, "onlineDays", "1")
    assert.entityCount("Run", 2)
  })
})
