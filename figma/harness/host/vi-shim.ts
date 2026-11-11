// The part of vitest's `vi` the fake Figma file uses (vi.fn), for the
// harness, which runs the fake in the browser outside any test.
type Fn = ((...args: unknown[]) => unknown) & {
  mock: { calls: unknown[][]; results: Array<{ type: 'return'; value: unknown }> };
  mockImplementation(impl: (...args: unknown[]) => unknown): Fn;
  getMockImplementation(): (...args: unknown[]) => unknown;
};

export const vi = {
  fn(impl: (...args: unknown[]) => unknown = () => undefined): Fn {
    let current = impl;
    const f = ((...args: unknown[]) => {
      f.mock.calls.push(args);
      const value = current(...args);
      f.mock.results.push({ type: 'return', value });
      return value;
    }) as Fn;
    f.mock = { calls: [], results: [] };
    f.mockImplementation = (next) => {
      current = next;
      return f;
    };
    f.getMockImplementation = () => current;
    return f;
  },
};
