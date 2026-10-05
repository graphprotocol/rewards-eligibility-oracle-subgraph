import { Address } from "@graphprotocol/graph-ts"

// The oracle's signing address on Arbitrum One. DataEdge's fallback accepts calls from anyone and
// Log(bytes) carries no sender, so every payload not sent by this address is ignored. If the oracle
// key is rotated, this has to change with it.
export const ORACLE_ADDRESS = Address.fromString("0xF0a445E553BF9Bd3670fE66fc95c41FdEbbC094A")

export const STATE_ID = "current"

export const SECONDS_PER_DAY: i64 = 86400
