import { listWidgets } from "./list-endpoint.js";

export function handleRequest(requestUrl) {
  const url = new URL(requestUrl, "https://rivet.example");
  if (url.pathname !== "/widgets") {
    return jsonResponse(404, { error: "not found" });
  }

  return jsonResponse(200, listWidgets());
}

function jsonResponse(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body,
  };
}
