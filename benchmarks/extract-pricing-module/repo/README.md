# Extract pricing module

The public suite covers ordinary invoices through the existing `invoice.js` API. The hidden suite
covers the threshold, integer-cent rounding, empty input, validation, and the extracted module's
exports. The seed is behaviorally complete so this is a refactor rather than a bug fix.
