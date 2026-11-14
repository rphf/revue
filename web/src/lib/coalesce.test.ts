import { expect, test } from "vitest";
import { coalesce } from "./coalesce";

test("a burst of calls during a load makes one more load after it", async () => {
  const done: (() => void)[] = [];
  let loads = 0;
  const load = coalesce(() => {
    loads += 1;
    return new Promise<void>((resolve) => done.push(resolve));
  });

  load();
  load();
  load();
  load();
  expect(loads).toBe(1);

  done[0]();
  await Promise.resolve();
  await Promise.resolve();
  expect(loads).toBe(2);

  done[1]();
  await Promise.resolve();
  await Promise.resolve();
  expect(loads).toBe(2);

  load();
  expect(loads).toBe(3);
});

test("a failed load does not block the next one", async () => {
  let loads = 0;
  const load = coalesce(() => {
    loads += 1;
    return Promise.reject(new Error("offline"));
  });

  load();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  load();
  expect(loads).toBe(2);
});
