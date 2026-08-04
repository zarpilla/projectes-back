// Sanity smoke test: confirms the Jest harness runs and basic Node assertions work.
// This is intentionally dependency-free so `npm test` is green from day one.
describe('smoke test', () => {
  test('jest is wired up', () => {
    expect(1 + 1).toBe(2);
  });

  test('Node runtime is >= 20 (Strapi v5 requirement)', () => {
    const [major] = process.versions.node.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
