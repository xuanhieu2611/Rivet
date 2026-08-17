# Bulk discount boundary

This seed deliberately has one inverted comparison in `src/discount.js`. The public suite names only
the boundary case at ten items; the hidden suite covers the values on both sides of the boundary and
preserves the input-validation contract.
