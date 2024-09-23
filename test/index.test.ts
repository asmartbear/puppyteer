import 'jest';      // Ref: https://jestjs.io/docs/en/expect#reference
import { Puppyteer } from '../src/index'


test("construction", () => {
  const m = new Puppyteer({ headless: true, taskRunner: {} });
});

