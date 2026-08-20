export class BookingRepository {
  constructor(database) {
    this.database = database;
  }

  hasConflictingSlot(roomId, slotStarts) {
    const find = this.database.prepare(
      "SELECT 1 FROM booking_slots WHERE room_id = ? AND starts_at = ? LIMIT 1",
    );
    return slotStarts.some((startsAt) => find.get(roomId, startsAt) !== undefined);
  }

  createBooking(booking, slotStarts) {
    const inserted = this.database
      .prepare("INSERT INTO bookings (room_id, guest_name, starts_at, ends_at) VALUES (?, ?, ?, ?)")
      .run(booking.roomId, booking.guestName, booking.startsAt, booking.endsAt);
    const bookingId = Number(inserted.lastInsertRowid);
    const insertSlot = this.database.prepare(
      "INSERT INTO booking_slots (booking_id, room_id, starts_at) VALUES (?, ?, ?)",
    );

    for (const startsAt of slotStarts) {
      insertSlot.run(bookingId, booking.roomId, startsAt);
    }

    return { id: bookingId, ...booking };
  }
}
