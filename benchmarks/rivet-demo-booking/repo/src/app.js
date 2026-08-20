import { BookingRepository } from "./booking-repository.js";
import { BookingConflictError, BookingService } from "./booking-service.js";
import { createBookingDatabase } from "./database.js";

export function createBookingApp(options = {}) {
  const database = createBookingDatabase();
  const repository = new BookingRepository(database);
  const service = new BookingService(repository, options.hooks);

  return {
    database,
    repository,
    close: () => database.close(),
    handleRequest: async (request) => {
      if (request.method !== "POST" || request.path !== "/bookings") {
        return response(404, { error: "not found" });
      }

      try {
        const booking = await service.bookRoom(request.body);
        return response(201, { booking });
      } catch (error) {
        if (error instanceof BookingConflictError) {
          return response(409, { error: error.message });
        }
        if (error instanceof TypeError) {
          return response(400, { error: error.message });
        }
        return response(500, { error: "internal server error" });
      }
    },
  };
}

function response(status, body) {
  return { status, headers: { "content-type": "application/json" }, body };
}
