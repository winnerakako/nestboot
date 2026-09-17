# __NAME__

TODO: one line on what this feature owns.

## Owns
- TODO: the tables and the concepts. Nothing else may write them.

## External dependencies
- TODO: providers, other features' contracts. None is a good answer.

## Non-obvious rules
- TODO: anything a reader would otherwise get wrong.

## Boundary
Other features import from `contracts/` only. This feature reacts to the rest of
the app through `listeners/`, and tells the rest of the app things by emitting
events — never by calling another feature's action.
