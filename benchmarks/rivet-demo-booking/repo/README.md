# Rivet demo booking service

A small room-booking API used for Rivet's public concurrency demo. It stores bookings and their
30-minute room slots in SQLite through Node's built-in database module.

## Run the tests

```bash
npm test
```

The repository intentionally starts at the commit referenced by the seeded GitHub issue. The public
test suite covers ordinary, adjacent and sequential-conflict requests.
