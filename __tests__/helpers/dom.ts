import { beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Scopes happy-dom's globals (document, window, HTMLElement, ...) to exactly
// the test file that calls this at its top level — register()/unregister()
// run around that file's own suite, so no other test file (including the
// ~168 existing server tests that rely on Bun's native fetch/Response) ever
// sees happy-dom's globals.
//
// Also scopes React's `IS_REACT_ACT_ENVIRONMENT` flag the same way, so tests
// in this file can use `act()` from `react` without React warning that the
// environment isn't configured for it.
const reactActEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

export function withDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register();
    reactActEnv.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    GlobalRegistrator.unregister();
    delete reactActEnv.IS_REACT_ACT_ENVIRONMENT;
  });
}
