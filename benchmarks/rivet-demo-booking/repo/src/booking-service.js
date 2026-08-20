const SLOT_MS = 30 * 60 * 1000;

export class BookingConflictError extends Error {
  constructor() {
    super("room is already booked for part of that time");
    this.name = "BookingConflictError";
  }
}

export class BookingService {
  constructor(repository, hooks = {}) {
    this.repository = repository;
    this.afterAvailabilityCheck = hooks.afterAvailabilityCheck ?? (() => Promise.resolve());
  }

  async bookRoom(input) {
    const booking = normalizeBooking(input);
    const slots = slotStarts(booking.startsAt, booking.endsAt);

    if (this.repository.hasConflictingSlot(booking.roomId, slots)) {
      throw new BookingConflictError();
    }

    await this.afterAvailabilityCheck();
    return this.repository.createBooking(booking, slots);
  }
}

function normalizeBooking(input) {
  if (!input || typeof input !== "object") throw new TypeError("booking body is required");
  const { roomId, guestName, startsAt, endsAt } = input;
  if (![roomId, guestName, startsAt, endsAt].every((value) => typeof value === "string")) {
    throw new TypeError("booking fields must be strings");
  }

  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new TypeError("booking times are invalid");
  }
  if (start % SLOT_MS !== 0 || end % SLOT_MS !== 0) {
    throw new TypeError("booking times must use 30-minute boundaries");
  }

  return {
    roomId,
    guestName,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
  };
}

function slotStarts(startsAt, endsAt) {
  const slots = [];
  for (let cursor = Date.parse(startsAt); cursor < Date.parse(endsAt); cursor += SLOT_MS) {
    slots.push(new Date(cursor).toISOString());
  }
  return slots;
}
