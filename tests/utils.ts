import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { newMockEvent } from "matchstick-as/assembly/index"
import { Log } from "../generated/DataEdge/EventfulDataEdge"
import { ORACLE_ADDRESS, SECONDS_PER_DAY } from "../src/constants"

// The test vector from docs/eligibility-metrics-publishing.md, produced by the oracle's encode_payload
export const TEST_VECTOR =
  "0x52450101f1a101d5a101f1a101bd018e010205018827d0860303f0a10102111111111111111111111111111111111111" +
  "1111f018c915066635c1020122222222222222222222222222222222222222221d000000021d0003f1a1010111111111" +
  "11111111111111111111111111111111b009cc08040a005a01"

export const INDEXER_1 = "0x1111111111111111111111111111111111111111"
export const INDEXER_2 = "0x2222222222222222222222222222222222222222"

// 2026-09-24 and 2026-09-25
export const DAY_24: i32 = 20720
export const DAY_25: i32 = 20721

export class RowSpec {
  constructor(
    public indexer: string,
    public queryAttempts: u64,
    public qualifyingQueries: u64,
    public qualifyingSubgraphs: u64,
    public isOnlineDay: u64
  ) {}
}

// Builds payloads the way the oracle's encode_payload does
export class PayloadBuilder {
  bytes: Array<u8> = new Array<u8>()

  constructor() {}

  static header(): PayloadBuilder {
    return new PayloadBuilder().raw(0x52).raw(0x45).varint(1)
  }

  // A complete payload: RunInfo for a 29-day window ending on runDay, then Criteria
  static run(runDay: i32, minSubgraphs: u64): PayloadBuilder {
    return PayloadBuilder.header()
      .varint(0x01)
      .varint(runDay as u64)
      .varint((runDay - 28) as u64)
      .varint(runDay as u64)
      .varint(189)
      .varint(142)
      .varint(0x02)
      .varint(5)
      .varint(minSubgraphs)
      .varint(5000)
      .varint(50000)
  }

  raw(byte: u8): PayloadBuilder {
    this.bytes.push(byte)
    return this
  }

  varint(value: u64): PayloadBuilder {
    do {
      let byte = (value & 0x7f) as u8
      value = value >> 7
      this.bytes.push(value != 0 ? byte | 0x80 : byte)
    } while (value != 0)
    return this
  }

  address(hex: string): PayloadBuilder {
    let address = Address.fromString(hex)
    for (let i = 0; i < address.length; i++) this.bytes.push(address[i])
    return this
  }

  day(day: i32, rows: Array<RowSpec>): PayloadBuilder {
    this.varint(0x03).varint(day as u64).varint(rows.length as u64)
    for (let i = 0; i < rows.length; i++) {
      let row = rows[i]
      this.address(row.indexer)
        .varint(row.queryAttempts)
        .varint(row.qualifyingQueries)
        .varint(row.qualifyingSubgraphs)
        .varint(0)
        .varint(0)
        .varint(0)
        .varint(row.isOnlineDay)
    }
    return this
  }

  build(): Bytes {
    let out = new Bytes(this.bytes.length)
    for (let i = 0; i < this.bytes.length; i++) out[i] = this.bytes[i]
    return out
  }
}

let nextLogIndex: i32 = 0

// A Log(bytes) event from the oracle, mined at the given day plus 10:05 UTC (a scheduled run)
export function createLogEvent(data: Bytes, blockDay: i32, from: Address = ORACLE_ADDRESS): Log {
  let event = changetype<Log>(newMockEvent())
  event.parameters = [new ethereum.EventParam("data", ethereum.Value.fromBytes(data))]
  event.transaction.from = from
  event.block.timestamp = BigInt.fromI64((blockDay as i64) * SECONDS_PER_DAY + 36300)
  // Distinct log index per event, so payload ids do not collide within a test
  nextLogIndex++
  event.logIndex = BigInt.fromI32(nextLogIndex)
  return event
}
