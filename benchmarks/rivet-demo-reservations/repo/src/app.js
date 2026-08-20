import {
  CancellationService,
  ReservationAlreadyCancelledError,
  ReservationNotFoundError,
} from "./cancellation-service.js";
import { ReservationStore } from "./reservation-store.js";

export function createReservationApp(reservations = []) {
  const store = new ReservationStore(reservations);
  const service = new CancellationService(store);

  return {
    store,
    handleRequest(request) {
      const route = request.path.match(/^\/customers\/([^/]+)\/reservations\/([^/]+)\/cancel$/);
      if (request.method !== "POST" || !route) {
        return response(404, { error: "not found" });
      }

      const customerId = decodeURIComponent(route[1]);
      const reference = decodeURIComponent(route[2]);
      try {
        return response(200, { reservation: service.cancel(customerId, reference) });
      } catch (error) {
        if (error instanceof ReservationNotFoundError) {
          return response(404, { error: error.message });
        }
        if (error instanceof ReservationAlreadyCancelledError) {
          return response(409, { error: error.message });
        }
        return response(500, { error: "internal server error" });
      }
    },
  };
}

function response(status, body) {
  return { status, headers: { "content-type": "application/json" }, body };
}
