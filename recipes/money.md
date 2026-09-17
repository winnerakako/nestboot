# Money

**Add it when** you store an amount. Which is to say: before you store the first
one.

**One-way doors: yes.** The column type is the decision. Changing it later means
rewriting the table and re-deriving every historical total.

## The rule

**Integer minor units, plus an explicit currency. Never a float.**

```ts
export const invoices = pgTable('invoices', {
  // 1234 = £12.34. bigint, not integer: integer tops out around £21M.
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),  // ISO 4217
});
```

`0.1 + 0.2 !== 0.3` in binary floating point. In an invoice total that is a
rounding error; across a ledger it is a reconciliation that never balances and
an afternoon nobody gets back. Postgres `numeric` is exact but arrives in
JavaScript as a string and is slower to aggregate; integers are exact, fast, and
impossible to misuse.

**Never a bare amount.** An `amountMinor` with no currency beside it is a number
whose meaning depends on context you will eventually get wrong. Carry them
together, always, and refuse to add two amounts of different currencies.

```ts
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatch(a.currency, b.currency);
  }
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}
```

Note `bigint`, not `number`: above 2^53 a JS number silently loses precision,
and JSON has no bigint — serialise as a string.

## Anything multi-step is a workflow

Charging a card, then recording the payment, then emailing a receipt is three
effects that must not half-happen. That is a workflow with a `step()` each, and
a compensating step for the reversal:

```ts
const transfer = await step('disburse', () =>
  // The workflow id as the idempotency key: a retry cannot double-charge.
  provider.transfer({ ...input, idempotencyKey: currentWorkflowId()! }),
);
if (transfer.status !== 'settled') {
  await step('reverse', () => provider.reverse(transfer.id));
}
```

## Also do this

- Round once, at the point of display, and never mid-calculation.
- Store the currency the customer was charged in, not a converted amount. Keep
  the rate and the timestamp if you converted.
- Make the ledger append-only. A correction is a new row, not an `UPDATE`.
