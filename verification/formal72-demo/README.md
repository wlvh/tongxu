# Formal workflow acceptance demonstration

This source is an explicitly labelled test fixture for tongxu Issue72 VM07. It is an isolated source tree.

## Functional contract

The functions are independent. For finite numbers with low <= high, clamp(value, low, high) returns value inside the inclusive range and preserves fractional values. normalizeLabel(value, fallback = "Untitled") trims the label and returns the supplied fallback when the trimmed label is empty. Without an explicit fallback, an empty label returns Untitled.

The two Node test files define protected acceptance cases. Only src/clamp.mjs and src/normalize.mjs within this demonstration may be repaired.
