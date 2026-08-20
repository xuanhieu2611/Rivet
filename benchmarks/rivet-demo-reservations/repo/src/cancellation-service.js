export class ReservationNotFoundError extends Error {
  constructor() {
    super("reservation not found");
    this.name = "ReservationNotFoundError";
  }
}

export class ReservationAlreadyCancelledError extends Error {
  constructor() {
    super("reservation is already cancelled");
    this.name = "ReservationAlreadyCancelledError";
  }
}

export class CancellationService {
  constructor(store) {
    this.store = store;
  }

  cancel(customerId, reference) {
    const reservation = this.store.findByReference(reference);
    if (!reservation) throw new ReservationNotFoundError();
    if (reservation.status === "cancelled") throw new ReservationAlreadyCancelledError();
    return this.store.cancel(reservation.id);
  }
}
