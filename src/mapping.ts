import { ExampleEvent } from "../generated/Example/Example"
import { ExampleEntity } from "../generated/schema"

export function handleExampleEvent(event: ExampleEvent): void {
  let entity = new ExampleEntity(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.account = event.params.account
  entity.value = event.params.value
  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash
  entity.save()
}
