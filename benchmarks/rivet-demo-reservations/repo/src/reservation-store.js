export class ReservationStore {
  constructor(reservations = []) {
    this.reservations = reservations.map((reservation) => ({ ...reservation }));
  }

  findByReference(reference) {
    return this.reservations.find((reservation) => reservation.reference === reference) ?? null;
  }

  cancel(id) {
    const reservation = this.reservations.find((candidate) => candidate.id === id);
    if (!reservation) return null;
    reservation.status = "cancelled";
    return { ...reservation };
  }

  snapshot() {
    return this.reservations.map((reservation) => ({ ...reservation }));
  }
}
