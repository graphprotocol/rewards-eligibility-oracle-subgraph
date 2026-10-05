import {
  assert,
  describe,
  test,
  clearStore,
  afterAll,
  newMockEvent
} from "matchstick-as/assembly/index"
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts"
import { ExampleEvent } from "../generated/Example/Example"
import { handleExampleEvent } from "../src/mapping"

function createExampleEvent(account: Address, value: BigInt): ExampleEvent {
  let event = changetype<ExampleEvent>(newMockEvent())
  event.parameters = new Array()
  event.parameters.push(
    new ethereum.EventParam("account", ethereum.Value.fromAddress(account))
  )
  event.parameters.push(
    new ethereum.EventParam("value", ethereum.Value.fromUnsignedBigInt(value))
  )
  return event
}

describe("handleExampleEvent", () => {
  afterAll(() => {
    clearStore()
  })

  test("stores an ExampleEntity", () => {
    let event = createExampleEvent(
      Address.fromString("0x0000000000000000000000000000000000000001"),
      BigInt.fromI32(42)
    )
    handleExampleEvent(event)

    let id = event.transaction.hash.concatI32(event.logIndex.toI32()).toHexString()
    assert.entityCount("ExampleEntity", 1)
    assert.fieldEquals("ExampleEntity", id, "value", "42")
  })
})
