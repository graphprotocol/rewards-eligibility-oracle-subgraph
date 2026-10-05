import { assert, beforeAll, describe, test } from "matchstick-as/assembly/index"
import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import { Day, Indexer, OracleState } from "../generated/schema"
import { handleLog } from "../src/mapping"
import { STATE_ID } from "../src/constants"
import { createLogEvent } from "./utils"
import {
  EXPECTED_FULLY_ONLINE_INDEXERS,
  EXPECTED_INDEXER_DAYS,
  EXPECTED_INDEXERS,
  EXPECTED_NEVER_ONLINE_INDEXERS,
  EXPECTED_ONLINE_ROWS,
  FIRST_ROW,
  FIRST_ROW_ID,
  LAST_ROW,
  LAST_ROW_ID,
  LAST_ROW_INDEXER,
  LAST_ROW_INDEXER_DAYS_WITH_ATTEMPTS,
  LAST_ROW_INDEXER_ONLINE_DAYS,
  MAINNET_PAYLOAD,
  MAINNET_PAYLOAD_TIMESTAMP
} from "./fixtures"

const COUNTERS = [
  "queryAttempts",
  "qualifyingQueries",
  "qualifyingSubgraphs",
  "failedStatus",
  "failedLatency",
  "failedBlocksBehind"
]

const DAYS = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]

describe("handleLog: first mainnet payload", () => {
  beforeAll(() => {
    let event = createLogEvent(Bytes.fromHexString(MAINNET_PAYLOAD), 0)
    event.block.timestamp = BigInt.fromI64(MAINNET_PAYLOAD_TIMESTAMP)
    handleLog(event)
  })

  test("stores the run", () => {
    assert.entityCount("Payload", 1)
    assert.fieldEquals("Run", "2026-10-05", "windowStartDay", "20703")
    assert.fieldEquals("Run", "2026-10-05", "windowEndDay", "20731")
    assert.fieldEquals("Run", "2026-10-05", "indexersEvaluated", "56")
    assert.fieldEquals("Run", "2026-10-05", "indexersEligible", "54")
    assert.fieldEquals("Run", "2026-10-05", "criteria", "5-1-5000-50000")
    assert.fieldEquals("OracleState", STATE_ID, "latestRun", "2026-10-05")
  })

  test("stores the six published days, all final", () => {
    assert.entityCount("Day", 6)
    for (let i = 0; i < DAYS.length; i++) {
      assert.fieldEquals("Day", DAYS[i], "isFinal", "true")
    }
    assert.notInStore("Day", "2026-10-05")
  })

  test("stores every row with the counters the Python decoder reads", () => {
    assert.entityCount("IndexerDay", EXPECTED_INDEXER_DAYS)
    assert.entityCount("Indexer", EXPECTED_INDEXERS)

    for (let i = 0; i < COUNTERS.length; i++) {
      assert.fieldEquals("IndexerDay", FIRST_ROW_ID, COUNTERS[i], FIRST_ROW[i])
      assert.fieldEquals("IndexerDay", LAST_ROW_ID, COUNTERS[i], LAST_ROW[i])
    }

    let onlineRows = 0
    for (let i = 0; i < DAYS.length; i++) {
      let day = Day.load(DAYS[i])!
      let indexerDays = day.indexerDays.load()
      for (let j = 0; j < indexerDays.length; j++) {
        if (indexerDays[j].isOnlineDay) onlineRows++
      }
    }
    assert.i32Equals(EXPECTED_ONLINE_ROWS, onlineRows)
  })

  test("computes rolling aggregates that agree with the published flags", () => {
    assert.fieldEquals("Indexer", LAST_ROW_INDEXER, "onlineDays", LAST_ROW_INDEXER_ONLINE_DAYS)
    assert.fieldEquals("Indexer", LAST_ROW_INDEXER, "daysWithAttempts", LAST_ROW_INDEXER_DAYS_WITH_ATTEMPTS)
    assert.fieldEquals("Indexer", LAST_ROW_INDEXER, "lastDayWithAttempts", "2026-10-04")

    let indexers = OracleState.load(STATE_ID)!.indexers
    let fullyOnline = 0
    let neverOnline = 0
    for (let i = 0; i < indexers.length; i++) {
      let indexer = Indexer.load(indexers[i])!
      if (indexer.onlineDays == DAYS.length) fullyOnline++
      if (indexer.onlineDays == 0) neverOnline++
    }
    assert.i32Equals(EXPECTED_FULLY_ONLINE_INDEXERS, fullyOnline)
    assert.i32Equals(EXPECTED_NEVER_ONLINE_INDEXERS, neverOnline)
  })
})
