import { cursorAuth } from "./auth.js";
import { overlayCursorCatalogue } from "./catalogue.js";

export function plugin() {
  return {
    auth: cursorAuth(),
    config: overlayCursorCatalogue,
  };
}

export default plugin;
