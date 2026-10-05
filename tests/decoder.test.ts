import { assert, describe, test } from "matchstick-as/assembly/index"
import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import { dayToDate, decodePayload } from "../src/decoder"
import { DAY_24, DAY_25, INDEXER_1, INDEXER_2, PayloadBuilder, RowSpec, TEST_VECTOR } from "./utils"

function expectError(data: Bytes, expected: string): void {
  let result = decodePayload(data)
  assert.assertNull(result.payload)
  assert.assertNotNull(result.error)
  assert.stringEquals(expected, result.error!)
}

function row(indexer: string, attempts: u64): RowSpec {
  return new RowSpec(indexer, attempts, attempts, 1, 1)
}

describe("decodePayload: test vector", () => {
  test("decodes the documented test vector", () => {
    let result = decodePayload(Bytes.fromHexString(TEST_VECTOR))
    assert.assertNull(result.error)
    let payload = result.payload!

    assert.i32Equals(DAY_25, payload.runInfo.runDay)
    assert.i32Equals(20693, payload.runInfo.windowStartDay)
    assert.i32Equals(DAY_25, payload.runInfo.windowEndDay)
    assert.bigIntEquals(BigInt.fromU64(189), BigInt.fromU64(payload.runInfo.indexersEvaluated))
    assert.bigIntEquals(BigInt.fromU64(142), BigInt.fromU64(payload.runInfo.indexersEligible))

    assert.bigIntEquals(BigInt.fromU64(5), BigInt.fromU64(payload.criteria.minOnlineDays))
    assert.bigIntEquals(BigInt.fromU64(1), BigInt.fromU64(payload.criteria.minSubgraphs))
    assert.bigIntEquals(BigInt.fromU64(5000), BigInt.fromU64(payload.criteria.maxLatencyMs))
    assert.bigIntEquals(BigInt.fromU64(50000), BigInt.fromU64(payload.criteria.maxBlocksBehind))

    assert.i32Equals(2, payload.days.length)

    let first = payload.days[0]
    assert.i32Equals(DAY_24, first.day)
    assert.i32Equals(2, first.rows.length)
    let a = first.rows[0]
    assert.bytesEquals(Bytes.fromHexString(INDEXER_1), a.indexer)
    assert.bigIntEquals(BigInt.fromU64(3184), BigInt.fromU64(a.queryAttempts))
    assert.bigIntEquals(BigInt.fromU64(2761), BigInt.fromU64(a.qualifyingQueries))
    assert.bigIntEquals(BigInt.fromU64(6), BigInt.fromU64(a.qualifyingSubgraphs))
    assert.bigIntEquals(BigInt.fromU64(102), BigInt.fromU64(a.failedStatus))
    assert.bigIntEquals(BigInt.fromU64(53), BigInt.fromU64(a.failedLatency))
    assert.bigIntEquals(BigInt.fromU64(321), BigInt.fromU64(a.failedBlocksBehind))
    assert.booleanEquals(true, a.isOnlineDay)
    let b = first.rows[1]
    assert.bytesEquals(Bytes.fromHexString(INDEXER_2), b.indexer)
    assert.bigIntEquals(BigInt.fromU64(29), BigInt.fromU64(b.queryAttempts))
    assert.bigIntEquals(BigInt.fromU64(0), BigInt.fromU64(b.qualifyingQueries))
    assert.bigIntEquals(BigInt.fromU64(2), BigInt.fromU64(b.failedLatency))
    assert.bigIntEquals(BigInt.fromU64(29), BigInt.fromU64(b.failedBlocksBehind))
    assert.booleanEquals(false, b.isOnlineDay)

    let second = payload.days[1]
    assert.i32Equals(DAY_25, second.day)
    assert.i32Equals(1, second.rows.length)
    let c = second.rows[0]
    assert.bytesEquals(Bytes.fromHexString(INDEXER_1), c.indexer)
    assert.bigIntEquals(BigInt.fromU64(1200), BigInt.fromU64(c.queryAttempts))
    assert.bigIntEquals(BigInt.fromU64(1100), BigInt.fromU64(c.qualifyingQueries))
    assert.bigIntEquals(BigInt.fromU64(4), BigInt.fromU64(c.qualifyingSubgraphs))
    assert.bigIntEquals(BigInt.fromU64(10), BigInt.fromU64(c.failedStatus))
    assert.bigIntEquals(BigInt.fromU64(0), BigInt.fromU64(c.failedLatency))
    assert.bigIntEquals(BigInt.fromU64(90), BigInt.fromU64(c.failedBlocksBehind))
    assert.booleanEquals(true, c.isOnlineDay)
  })
})

describe("decodePayload: varints", () => {
  test("decodes 64-bit counters, including the largest value", () => {
    let data = PayloadBuilder.run(DAY_25, 1)
      .day(DAY_25, [new RowSpec(INDEXER_1, U64.MAX_VALUE, 16384, 128, 1)])
      .build()
    let result = decodePayload(data)
    assert.assertNull(result.error)
    let decoded = result.payload!.days[0].rows[0]
    assert.bigIntEquals(BigInt.fromU64(U64.MAX_VALUE), BigInt.fromU64(decoded.queryAttempts))
    assert.bigIntEquals(BigInt.fromU64(16384), BigInt.fromU64(decoded.qualifyingQueries))
    assert.bigIntEquals(BigInt.fromU64(128), BigInt.fromU64(decoded.qualifyingSubgraphs))
  })

  test("rejects a varint cut off by the end of the payload", () => {
    expectError(PayloadBuilder.header().varint(0x01).raw(0x80).build(), "payload ended in the middle of a varint")
  })

  test("rejects a varint whose value does not fit in 64 bits", () => {
    let builder = PayloadBuilder.header().varint(0x01)
    for (let i = 0; i < 9; i++) builder.raw(0xff)
    expectError(builder.raw(0x02).build(), "varint does not fit in 64 bits")
  })

  test("rejects a varint longer than ten bytes", () => {
    let builder = PayloadBuilder.header().varint(0x01)
    for (let i = 0; i < 10; i++) builder.raw(0x80)
    expectError(builder.raw(0x00).build(), "varint is longer than 64 bits")
  })

  test("rejects a day that does not fit in an Int", () => {
    expectError(
      PayloadBuilder.header().varint(0x01).varint(2147483648).build(),
      "day is out of range: 2147483648"
    )
  })
})

describe("decodePayload: framing", () => {
  test("rejects payloads without the magic bytes", () => {
    expectError(Bytes.fromHexString("0x0001"), "payload does not carry the expected magic bytes")
    expectError(Bytes.fromHexString("0x52"), "payload does not carry the expected magic bytes")
    expectError(new Bytes(0), "payload does not carry the expected magic bytes")
  })

  test("rejects an unsupported version", () => {
    expectError(new PayloadBuilder().raw(0x52).raw(0x45).varint(2).build(), "unsupported encoding version: 2")
  })

  test("rejects an unknown message tag", () => {
    expectError(PayloadBuilder.run(DAY_25, 1).varint(0x7f).build(), "unknown message tag: 127")
  })

  test("reads tags as varints", () => {
    expectError(PayloadBuilder.run(DAY_25, 1).varint(300).build(), "unknown message tag: 300")
  })

  test("rejects a payload with no RunInfo", () => {
    let data = PayloadBuilder.header().varint(0x02).varint(5).varint(1).varint(5000).varint(50000).build()
    expectError(data, "payload carries no RunInfo")
  })

  test("rejects a payload with no Criteria", () => {
    let data = PayloadBuilder.header().varint(0x01).varint(DAY_25).varint(DAY_25 - 28).varint(DAY_25).varint(1).varint(1).build()
    expectError(data, "payload carries no Criteria")
  })

  test("rejects a second RunInfo", () => {
    let data = PayloadBuilder.run(DAY_25, 1).varint(0x01).varint(DAY_25).varint(DAY_25 - 28).varint(DAY_25).varint(1).varint(1).build()
    expectError(data, "payload carries more than one RunInfo")
  })

  test("rejects a second Criteria", () => {
    let data = PayloadBuilder.run(DAY_25, 1).varint(0x02).varint(5).varint(1).varint(5000).varint(50000).build()
    expectError(data, "payload carries more than one Criteria")
  })

  test("rejects an inverted window", () => {
    let data = PayloadBuilder.header()
      .varint(0x01).varint(DAY_25).varint(DAY_25).varint(DAY_25 - 1).varint(1).varint(1)
      .varint(0x02).varint(5).varint(1).varint(5000).varint(50000)
      .build()
    expectError(data, "window ends before it starts")
  })

  test("rejects an implausibly wide window", () => {
    let data = PayloadBuilder.header()
      .varint(0x01).varint(DAY_25).varint(0).varint(DAY_25).varint(1).varint(1)
      .varint(0x02).varint(5).varint(1).varint(5000).varint(50000)
      .build()
    expectError(data, "window is wider than 366 days")
  })

  test("accepts a payload with no days", () => {
    let result = decodePayload(PayloadBuilder.run(DAY_25, 1).build())
    assert.assertNull(result.error)
    assert.i32Equals(0, result.payload!.days.length)
  })
})

describe("decodePayload: daily metrics", () => {
  test("rejects a row count that runs past the end", () => {
    let data = PayloadBuilder.run(DAY_25, 1).varint(0x03).varint(DAY_25).varint(1000000).build()
    expectError(data, "row count runs past the end of the payload: 1000000")
  })

  test("rejects a varint cut off at the end of a row", () => {
    // 27 bytes passes the row count check, but the last counter has its continuation bit set
    let builder = PayloadBuilder.run(DAY_25, 1).varint(0x03).varint(DAY_25).varint(1).address(INDEXER_1)
    for (let i = 0; i < 6; i++) builder.varint(0)
    expectError(builder.raw(0x80).build(), "payload ended in the middle of a varint")
  })

  test("rejects an address cut off by the end of the payload", () => {
    // Two rows claimed and 54 bytes present, but the first row's 3-byte counters leave 15 bytes for
    // the second address
    let builder = PayloadBuilder.run(DAY_25, 1).varint(0x03).varint(DAY_25).varint(2).address(INDEXER_1)
    for (let i = 0; i < 6; i++) builder.varint(16384)
    builder.varint(1)
    for (let i = 0; i < 15; i++) builder.raw(0x22)
    expectError(builder.build(), "payload ended in the middle of an indexer address")
  })

  test("rejects is_online_day other than 0 or 1", () => {
    let data = PayloadBuilder.run(DAY_25, 1).day(DAY_25, [new RowSpec(INDEXER_1, 1, 1, 1, 2)]).build()
    expectError(data, "is_online_day is not 0 or 1: 2")
  })

  test("rejects the same day twice", () => {
    let data = PayloadBuilder.run(DAY_25, 1).day(DAY_25, [row(INDEXER_1, 1)]).day(DAY_25, [row(INDEXER_2, 1)]).build()
    expectError(data, "payload carries day 20721 twice")
  })

  test("accepts days that are not consecutive", () => {
    let data = PayloadBuilder.run(DAY_25, 1).day(DAY_25 - 3, [row(INDEXER_1, 1)]).day(DAY_25, [row(INDEXER_1, 1)]).build()
    let result = decodePayload(data)
    assert.assertNull(result.error)
    assert.i32Equals(2, result.payload!.days.length)
  })
})

describe("dayToDate", () => {
  test("converts days since the epoch to ISO dates", () => {
    assert.stringEquals("1970-01-01", dayToDate(0))
    assert.stringEquals("2026-08-28", dayToDate(20693))
    assert.stringEquals("2026-09-25", dayToDate(20721))
    assert.stringEquals("2024-02-29", dayToDate(19782))
    assert.stringEquals("2000-03-01", dayToDate(11017))
  })
})
