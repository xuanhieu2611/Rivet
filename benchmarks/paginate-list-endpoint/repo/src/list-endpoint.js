import { WIDGETS } from "./widgets.js";

export function listWidgets() {
  return {
    items: WIDGETS,
    totalItems: WIDGETS.length,
  };
}
